/**
 * Clint Eastwood post-write verification (read-only, disk only; the captures
 * come from the Phase-4 backup sweeps). READ-BACK IS LOAD-BEARING; acks do not
 * count. Run: npx tsx samples/_scratch/clint-verify.ts
 *
 * Asserts (plan §4 step 13):
 *  A. Neighbour identity: pack5 slot 9 (Amber 01) == amber-authored-2026-07-29
 *     (== the levels-universal-era canonical, re-confirmed byte-identical in the
 *     Sugar session); slot 46 (Sugar 1) == sugar-authored-2026-07-30; slot 35
 *     (Breakdown P1) == card-backup-2026-07-29/pack5.
 *  B. Headers on all 8: name @0x10, colour 7 (Lime) @0x0c, tempo 85 @0x34,
 *     swing 50, scale 0/15 Chromatic, synth levels 0/0 @0x2701c/d, drum levels
 *     0 x4, drum binding [1,2,5,11] @0x1a278.
 *  C. Layout: plain chains [0,7] on 27/28/30, [0,4] on 29, [0,6] on 33, [0,2]
 *     on 34 (scene end byte 0); scene tables on 31/32 (end byte 3 = 4 steps),
 *     runs [0-1][0-5][4-5][4-7] and [0-1][0-5][4-4][6-6] on EVERY union track,
 *     plain chains cleared. Length bytes: 27 [23,31x6,15], 31 [31x7,15],
 *     32 [31x6,15], else 31 on every authored pattern.
 *  D. Content: FULL per-step decode of every note track against the staged
 *     rows — melodic pitch+gate+tie+velocity at stored pitch (staged +12, the
 *     transpose arg); midi2 per-hit (note, velocity) pairs at GM+12. Tracks
 *     outside a project's union decode EMPTY.
 *  E. Internal condensed layer: reproduced with the SHIPPED condenseToKit on
 *     the kit the descriptor declares, then asserted step-exact on all four
 *     drum tracks (velocity + micro-hit included), plus the kick-lane check.
 *  F. Tails, the crash-61 cell map, the m49 flourish, and the fusion's scene
 *     tables — decoded from the bytes, not from the receipts.
 *  G. External note-set sweep: {48,50,54,57,58,61,68} exactly, nothing else.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneNoteChain, getSceneDrumChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { condenseToKit } from '../../packages/core/src/protocol-generic/patterns/drumCondense.js';
import type { DrumRole } from '../../packages/core/src/protocol-generic/patterns/drumRoles.js';
import type { NeutralPattern, Step } from '../../packages/core/src/protocol-generic/patterns/types.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const NEW_DIR = `${ROOT}/samples/circuit-ncs/clint-authored-2026-07-30`;
const NB_DIR = `${ROOT}/samples/circuit-ncs/clint-neighbour-2026-07-30`;
const ORACLE = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/clint-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; pc: number; layout: 'chain' | 'scenes';
  order: string[]; sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
  expect_letters: string;
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
byteIdent('pack5 slot 9 (Amber 01 Intro) vs amber-authored-2026-07-29 (the levels-universal-era canonical)',
  nb.get(9), loadDir(`${ROOT}/samples/circuit-ncs/amber-authored-2026-07-29`).get(9));
byteIdent('pack5 slot 46 (Sugar 1 IntroVrs) vs sugar-authored-2026-07-30 (the concurrent build)',
  nb.get(46), loadDir(`${ROOT}/samples/circuit-ncs/sugar-authored-2026-07-30`).get(46));
byteIdent('pack5 slot 35 (Breakdown P1, the slot right after the build) vs card-backup-2026-07-29',
  nb.get(35), readFileSync(`${ORACLE}/proj35__34_SESSION.ncs`) as Buffer);

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const TRANSPOSE = 12;
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, perc: 68 };
const KIT_VOICES = Object.keys(GM12);
/** The descriptor's declared internal roster (DRUM_TRACK_BASE_VOICES). */
const KIT: readonly DrumRole[] = ['kick', 'snare', 'closed_hat', 'ride'];
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const midiName = (n: number): string => {
  const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  return NAMES[n % 12] + (Math.floor(n / 12) - 1);
};

interface ExpNote { notes: number[]; gateSixths?: number; tie: boolean; velocity: number }
const expectedRow = (row: string, steps: number, transpose: number): (ExpNote | undefined)[] => {
  const parsed = parseVoice(row, steps) as Array<{
    on?: boolean; notes?: number | number[]; gate_sixths?: number; tie?: boolean; velocity?: number;
  }>;
  return parsed.map((s) => {
    if (s.on !== true) return undefined;
    const notes = (Array.isArray(s.notes) ? [...s.notes] : (s.notes !== undefined ? [s.notes] : []))
      .map((n) => n + transpose).sort((a, b) => a - b);
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

/** Per-slot pattern -> stored section (chain duplicates plays, scenes store cells once). */
const shapeOf = (st: (typeof STAGED)[number]): { patterns: number; secOfPattern: (p: number) => (typeof STAGED)[number]['sections'][number] } => {
  const byName = new Map(st.sections.map((s) => [s.name, s]));
  return st.layout === 'chain'
    ? { patterns: st.order.length, secOfPattern: (p) => byName.get(st.order[p])! }
    : { patterns: st.sections.length, secOfPattern: (p) => st.sections[p] };
};

/** Expected scene runs per §1 (inclusive, 0-based pattern indices). */
const SCENE_RUNS: Record<number, Array<{ start: number; end: number }>> = {
  31: [{ start: 0, end: 1 }, { start: 0, end: 5 }, { start: 4, end: 5 }, { start: 4, end: 7 }],
  32: [{ start: 0, end: 1 }, { start: 0, end: 5 }, { start: 4, end: 4 }, { start: 6, end: 6 }],
};
/** Expected plain-chain end (0-based last pattern) per §4 step 13. */
const CHAIN_END: Record<number, number> = { 27: 7, 28: 7, 29: 4, 30: 7, 33: 6, 34: 2 };
/** Expected length bytes per §4 step 13. */
const LEN_BYTES: Record<number, number[]> = {
  27: [23, 31, 31, 31, 31, 31, 31, 15],
  28: [31, 31, 31, 31, 31, 31, 31, 31],
  29: [31, 31, 31, 31, 31],
  30: [31, 31, 31, 31, 31, 31, 31, 31],
  31: [31, 31, 31, 31, 31, 31, 31, 15],
  32: [31, 31, 31, 31, 31, 31, 15],
  33: [31, 31, 31, 31, 31, 31, 31],
  34: [31, 31, 31],
};

const strayNotes = new Set<number>();
const seenNotes = new Set<number>();
const realized = new Map<string, number>();
let condenseCollisions = 0;

console.log('\n=== B/C/D/E. slots 27-34: header, layout, content, condensed layer ===');
for (const st of STAGED) {
  const buf = authored.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const shape = shapeOf(st);
  const n = shape.patterns;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns, ${st.layout}) --`);

  // B. header
  const name = getProjectName(buf as unknown as Uint8Array);
  check(name === st.project_name, `name "${name}"`, `slot ${st.slot} name "${name}" != "${st.project_name}"`);
  check(buf[0x0c] === 7, 'colour 7 (Lime)', `slot ${st.slot} colour ${buf[0x0c]} != 7`);
  check(buf[0x34] === 85, 'tempo 85', `slot ${st.slot} tempo ${buf[0x34]} != 85`);
  const swing = getProjectSwing(buf as unknown as Uint8Array);
  check(swing === 50, 'swing 50', `slot ${st.slot} swing ${swing} != 50`);
  check(buf[0x26d0c] === 0 && buf[0x26d0d] === 15, 'scale root C / Chromatic (0/15)',
    `slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  check(buf[0x2701c] === 0 && buf[0x2701d] === 0, 'synth levels 0/0 (universal stored-silent)',
    `slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  check(dl.every((x) => x === 0), 'drum levels 0 x4 (the blend layer lies silent)', `slot ${st.slot} drum levels [${dl}]`);
  const binding = getDrumSampleBinding(buf as unknown as Uint8Array);
  check(eq(binding, [1, 2, 5, 11]), 'drum binding [1,2,5,11] (the freshly seeded pack-5 pool)',
    `slot ${st.slot} binding [${binding}] != [1,2,5,11]`);

  // union tracks
  const union: NoteTrack[] = [];
  for (const t of ['synth1', 'synth2', 'midi1'] as NoteTrack[]) {
    if (st.sections.some((s) => s.voices[t] !== undefined)) union.push(t);
  }
  const hasKit = st.sections.some((s) => Object.keys(s.voices).some((v) => KIT_VOICES.includes(v)));
  if (hasKit) union.push('midi2');

  // C. layout
  if (st.layout === 'chain') {
    check(buf[0x2c1] === 0, 'scene end byte 0 (plain pattern chain)', `slot ${st.slot} scene end byte ${buf[0x2c1]}`);
    for (const t of union) {
      const c = chainOf(buf, NOTE_CHAIN_IDX[t]);
      check(eq(c, [0, CHAIN_END[st.slot]]), `${t} chain [${c}]`, `slot ${st.slot} ${t} chain [${c}] != [0,${CHAIN_END[st.slot]}]`);
    }
  } else {
    const runs = SCENE_RUNS[st.slot];
    check(buf[0x2c1] === runs.length - 1, `scene-chain end byte ${runs.length - 1} (${runs.length} scene steps)`,
      `slot ${st.slot} scene end byte ${buf[0x2c1]} != ${runs.length - 1}`);
    for (const t of union) {
      const got = runs.map((_, sc) => getSceneNoteChain(buf as unknown as Uint8Array, sc, t));
      check(eq(got, runs), `${t} scene table ${runs.map((r) => `[${r.start + 1}-${r.end + 1}]`).join('')} == §1`,
        `slot ${st.slot} ${t} scenes ${JSON.stringify(got)} != ${JSON.stringify(runs)}`);
      const c = chainOf(buf, NOTE_CHAIN_IDX[t]);
      check(eq(c, [0, 0]), `${t} plain chain cleared [0,0] (scenes must not be shadowed)`, `slot ${st.slot} ${t} plain chain [${c}] not cleared`);
    }
    for (let d = 0; d < 4; d++) {
      const got = runs.map((_, sc) => getSceneDrumChain(buf as unknown as Uint8Array, sc, d));
      check(eq(got, runs), `Drum${d + 1} scene table matches the note tracks`, `slot ${st.slot} Drum${d + 1} scenes ${JSON.stringify(got)}`);
    }
  }
  // Condensed rows per pattern, reused by the length-byte check and by E.
  // A drum track is in the project's UNION only if some section puts a hit on
  // it (Solo 3 has zero crash, so its ride track is never authored and keeps
  // the template's length byte — the writer's documented empty-fill scope).
  const condRows: Array<Array<Step[]>> = [];
  for (let p = 0; p < n; p++) {
    const sec = shape.secOfPattern(p);
    const voices: Record<string, { steps: Step[] }> = {};
    for (const [v, row] of Object.entries(sec.voices)) {
      if (MELODIC.has(v)) continue;
      voices[v] = { steps: parseVoice(row, sec.steps) as Step[] };
    }
    const cond = condenseToKit({ name: sec.name, steps: sec.steps, bars: 1, voices } as NeutralPattern, KIT);
    condenseCollisions += cond.collisions.length;
    condRows.push(KIT.map((role) => cond.pattern.voices[role]?.steps ?? []));
  }
  const drumUnion = [0, 1, 2, 3].filter((d) => condRows.some((rows) => rows[d].some((s) => s?.on === true)));

  // length bytes
  {
    const want = LEN_BYTES[st.slot];
    let bad = 0; const seen: number[] = [];
    for (let p = 0; p < n; p++) {
      seen.push(buf[META_OFFSETS[noteBlockIndex(union[0], p)]]);
      for (const t of union) if (buf[META_OFFSETS[noteBlockIndex(t, p)]] !== want[p]) bad++;
      for (const d of drumUnion) if (buf[META_OFFSETS[drumBlockIndex(d, p)]] !== want[p]) bad++;
    }
    check(bad === 0 && eq(seen, want),
      `length bytes [${seen.join(',')}] on every authored pattern of every union note track + Drum${drumUnion.map((d) => d + 1).join('/')}`,
      `slot ${st.slot} length bytes [${seen.join(',')}] vs [${want.join(',')}] (${bad} track-level mismatches)`);
  }

  // D. content: melodic tracks at STORED pitch (staged + transpose 12)
  for (const t of union.filter((x) => MELODIC.has(x))) {
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = shape.secOfPattern(p);
      const row = sec.voices[t];
      const exp = row !== undefined ? expectedRow(row, sec.steps, TRANSPOSE) : Array<ExpNote | undefined>(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf as unknown as Uint8Array, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; tie: boolean; velocity: number }> }>;
      for (let s = 0; s < sec.steps; s++) {
        asserts++;
        const e = exp[s]; const g = got[s];
        const key = `${st.slot}/${t}/p${p + 1}/s${s}`;
        if (e === undefined) {
          if (g.active) { bad++; if (bad < 4) fail(`${key}: unexpected onset [${g.notes.map((x) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 4) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x) => x.note).sort((a, b) => a - b);
        if (!eq(gp, e.notes)) { bad++; if (bad < 4) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        for (const sn of g.notes) {
          if (e.gateSixths !== undefined && sn.gate !== e.gateSixths) { bad++; if (bad < 4) fail(`${key}: gate ${sn.gate} != ${e.gateSixths}`); }
          if (sn.tie !== e.tie) { bad++; if (bad < 4) fail(`${key}: tie ${sn.tie} != ${e.tie}`); }
          if (sn.velocity !== e.velocity) { bad++; if (bad < 4) fail(`${key}: vel ${sn.velocity} != ${e.velocity}`); }
        }
        realized.set(t, (realized.get(t) ?? 0) + gp.length);
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows +12 (pitch+gate+tie+velocity exact)`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }
  // midi2 external leg
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
          seenNotes.add(nt);
          if (!Object.values(GM12).includes(nt)) strayNotes.add(nt);
        }
        realized.set('midi2', (realized.get('midi2') ?? 0) + gotPairs.length);
        if (!eq(gotPairs, expPairs)) { bad++; if (bad < 4) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`); }
      }
    }
    if (bad === 0) ok('midi2: per-hit (note,velocity) pairs == the staged union rows at GM+12');
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
  }
  // tracks outside the union decode EMPTY
  {
    let stray = 0;
    const outside = NOTE_TRACKS.filter((x) => !union.includes(x));
    for (const t of outside) for (let p = 0; p < 8; p++) {
      (decodeNotePattern(buf as unknown as Uint8Array, t, p) as Array<{ active: boolean }>).forEach((s) => { if (s.active) stray++; });
    }
    check(stray === 0, `non-union note tracks decode EMPTY (${outside.join(',') || 'none'})`,
      `slot ${st.slot}: ${stray} active steps on non-union tracks`);
  }

  // E. internal condensed blend layer, reproduced with the SHIPPED condenser
  {
    let bad = 0; let hits = 0; let kickHits = 0;
    for (let p = 0; p < n; p++) {
      const sec = shape.secOfPattern(p);
      for (const d of drumUnion) {
        const expRow = condRows[p][d];
        const got = decodeDrumPattern(buf as unknown as Uint8Array, d, p) as Array<{ active: boolean; velocity: number; microHits: number }>;
        for (let s = 0; s < sec.steps; s++) {
          asserts++;
          const e = expRow[s];
          const g = got[s];
          const on = e?.on === true;
          if (on !== g.active) { bad++; if (bad < 4) fail(`${st.slot}/Drum${d + 1}/p${p + 1}/s${s}: active ${g.active} != ${on}`); continue; }
          if (!on) continue;
          hits++;
          if (d === 0) kickHits++;
          const expVel = e!.velocity ?? 100;
          if (g.velocity !== expVel) { bad++; if (bad < 4) fail(`${st.slot}/Drum${d + 1}/p${p + 1}/s${s}: vel ${g.velocity} != ${expVel}`); }
        }
      }
    }
    check(bad === 0, `internal Drum1-4 decode == condenseToKit(${KIT.join('/')}) step-exact (${hits} hits, kick lane ${kickHits})`,
      `slot ${st.slot}: ${bad} condensed-drum mismatches`);
    // The kick lane has no same-family contender, so it must equal the staged
    // kick row exactly — the What I Got kick-lane method, run independently.
    let kbad = 0;
    for (let p = 0; p < n; p++) {
      const sec = shape.secOfPattern(p);
      const kick = sec.voices.kick;
      const exp = kick !== undefined ? rowHits(kick) : Array<number | undefined>(sec.steps).fill(undefined);
      const got = decodeDrumPattern(buf as unknown as Uint8Array, 0, p) as Array<{ active: boolean; velocity: number }>;
      for (let s = 0; s < sec.steps; s++) {
        const e = exp[s];
        if ((e !== undefined) !== got[s].active || (e !== undefined && got[s].velocity !== e)) kbad++;
      }
    }
    check(kbad === 0, 'kick lane (Drum1) exact-step == the staged kick row on every pattern', `slot ${st.slot}: ${kbad} kick-lane mismatches`);
  }
}

// == F. tails, crash map, the fusion ==================================
console.log('\n=== F. tails + crash-61 cell map + the m49 flourish (from the DECODED bytes) ===');
const patternNotes = (buf: Buffer, track: NoteTrack, p: number): Array<{ step: number; note: number; velocity: number }> => {
  const out: Array<{ step: number; note: number; velocity: number }> = [];
  (decodeNotePattern(buf as unknown as Uint8Array, track, p) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>)
    .forEach((s, i) => { if (s.active) for (const x of s.notes) out.push({ step: i, note: x.note, velocity: x.velocity }); });
  return out;
};
{
  // crash-61 by PATTERN, then mapped back to the §1 letters via the staged order.
  const WANT: Record<number, string[]> = {
    27: ['A', 'D'], 28: ['E', 'K'], 29: ['L', 'O'], 30: ['P', 'S', 'E'],
    31: ['W', 'X', 'a0', 'a1'], 32: ['a4'], 33: [], 34: ['a10', 'a11'],
  };
  for (const st of STAGED) {
    const buf = authored.get(st.slot)!;
    const shape = shapeOf(st);
    const letters = st.expect_letters.split(' ');
    const nameToLetter = new Map<string, string>();
    st.order.forEach((nm, i) => { if (!nameToLetter.has(nm)) nameToLetter.set(nm, letters[i]); });
    const got = new Set<string>();
    for (let p = 0; p < shape.patterns; p++) {
      if (patternNotes(buf, 'midi2', p).some((x) => x.note === 61)) got.add(nameToLetter.get(shape.secOfPattern(p).name)!);
    }
    check(eq([...got].sort(), [...WANT[st.slot]].sort()),
      `slot ${st.slot} crash-61 cells [${[...got].sort().join(',') || '(none)'}] == §4 step 13`,
      `slot ${st.slot} crash cells [${[...got].sort().join(',')}] != [${WANT[st.slot].join(',')}]`);
  }
}
{
  // slot 27 pattern 8 = m15: 16 steps, the bass pickup + crash.
  const buf = authored.get(27)!;
  const bass = patternNotes(buf, 'synth1', 7);
  const drums = patternNotes(buf, 'midi2', 7);
  check(buf[META_OFFSETS[noteBlockIndex('synth1', 7)]] === 15 && bass.length > 0 && drums.some((x) => x.note === 61),
    `slot 27 pat 8 = m15 alone (16 steps): the bass pickup (${bass.length} notes, ${midiName(Math.min(...bass.map((x) => x.note)))}..${midiName(Math.max(...bass.map((x) => x.note)))}) + crash`,
    'slot 27 tail wrong');
  // Patterns 1-7 carry NO bass (it enters at m15 only).
  let early = 0;
  for (let p = 0; p < 7; p++) early += patternNotes(buf, 'synth1', p).length;
  check(early === 0, 'slot 27 patterns 1-7: synth1 EMPTY (bass enters only at m15, the tab)', `slot 27: ${early} bass notes before pattern 8`);
  check(buf[META_OFFSETS[noteBlockIndex('synth2', 0)]] === 23, 'slot 27 pat 1 length byte 23 (24 steps = the 2/4 pickup fused with m2)', 'slot 27 pat 1 length wrong');
}
{
  const b31 = authored.get(31)!;
  check(b31[META_OFFSETS[noteBlockIndex('midi2', 7)]] === 15 && patternNotes(b31, 'midi2', 7).some((x) => x.note === 61),
    'slot 31 pat 8 = the m84 turnaround (16 steps, crash) inside a 4-step scene table — the first 16-step cell in scenes',
    'slot 31 tail wrong');
  const b32 = authored.get(32)!;
  check(b32[META_OFFSETS[noteBlockIndex('midi2', 6)]] === 15, 'slot 32 pat 7 = m103 (16 steps) inside a 4-step scene table', 'slot 32 tail wrong');
  const b34 = authored.get(34)!;
  const fin = patternNotes(b34, 'midi2', 2).filter((x) => x.note === 61);
  check(fin.length > 0, `slot 34 pat 3 = m122-123, the final crash (${fin.length} crash hit(s))`, 'slot 34 final crash missing');
}
{
  // The m49 flourish: slot 30 pattern 4 carries tom 57 + openhat 58 + crash 61
  // in the same bar (the timbale is folded onto the tom pad).
  const buf = authored.get(30)!;
  const notes = patternNotes(buf, 'midi2', 3);
  const has = (n: number): boolean => notes.some((x) => x.note === n);
  const toms = notes.filter((x) => x.note === 57).length;
  check(has(57) && has(58) && has(61),
    `m49 flourish decoded in slot 30 pattern 4: tom 57 x${toms} (incl. the 2 timbale folds) + openhat 58 + crash 61`,
    'm49 flourish missing from slot 30 pattern 4');
  // openhat 58 exists NOWHERE else in the build (source has 2 hits, both m49).
  let oh = 0;
  for (const st of STAGED) {
    const b = authored.get(st.slot)!;
    for (let p = 0; p < 8; p++) oh += patternNotes(b, 'midi2', p).filter((x) => x.note === 58).length;
  }
  check(oh === 2, 'openhat 58 appears exactly twice in the whole build, both in the m49 flourish (source-true)', `openhat 58 stored ${oh} times`);
}

// == G. external note-set sweep + totals ==============================
console.log('\n=== G. external note set + realized totals ===');
check(strayNotes.size === 0, `midi2 note set == {${[...seenNotes].sort((a, b) => a - b).join(',')}} (kick/snare/hat/tom/openhat/crash/perc at GM+12), nothing stray`,
  `stray midi2 notes [${[...strayNotes].sort((a, b) => a - b)}]`);
check(eq([...seenNotes].sort((a, b) => a - b), [48, 50, 54, 57, 58, 61, 68]), 'all seven kit pads present across the build',
  `note set [${[...seenNotes].sort((a, b) => a - b)}] != [48,50,54,57,58,61,68]`);
for (const [k, v] of [...realized.entries()].sort()) info(`stored ${k}: ${v} onsets across the 8 projects (stored once per distinct cell; replays are chain/scene pointers)`);
info(`condense contention across the build: ${condenseCollisions} steps where two same-family pieces competed for one internal track (louder kept the step)`);

console.log(`\n${failures === 0 ? `ALL ${asserts} VERIFICATION ASSERTS PASS` : `${failures} FAILURES of ${asserts} asserts`}`);
process.exitCode = failures === 0 ? 0 : 1;
