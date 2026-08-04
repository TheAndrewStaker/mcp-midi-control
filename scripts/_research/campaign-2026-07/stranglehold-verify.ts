/**
 * Stranglehold Phase 4 decode-verify (plan §4 step 12, the Brain Stew slot-36
 * discipline): READ-BACK IS LOAD-BEARING — acks do not count.
 *
 * Decodes samples/circuit-ncs/stranglehold-authored-2026-07-30/ (the authored
 * sweep) and asserts, per slot:
 *   - meta: name, colour 2 (Peach), tempo 72, swing 50, scale 0/15, synth
 *     levels 0/0, drum levels 0 x4, patch bodies == blank_slot20 template
 *   - plain chains whose decoded ranges == §1, NO scene table anywhere
 *   - length byte 32 on EVERY chained pattern, including the P1/P6 rest patterns
 *   - FULL per-step midi2 decode == the staged rows (note, velocity per step)
 *   - THE DRONE (fork Q2 = KEEP): every authored midi1 pattern decodes to one
 *     of the TWO cell shapes taken from the ORACLE'S OWN BYTES
 *     (card-backup-2026-07-29), and the per-slot sequence is the intended one
 *   - synth1/synth2 + all four internal drum tracks EMPTY x6
 *   - stored note set == {48,50,54,57,58,61,63}; ZERO 51, ZERO 68
 *   - every §3 tail assertion incl. the three restored-content heads
 * Plus NEIGHBOUR IDENTITY: slots 9 / 27 / 46 byte-compared to their canonicals.
 *
 * READ-ONLY, disk only. Run: npx tsx samples/_scratch/stranglehold-verify.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getProjectName, NOTE_TRACKS, type NoteTrack, META_OFFSETS, noteBlockIndex } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const AUTHORED = `${ROOT}/samples/circuit-ncs/stranglehold-authored-2026-07-30`;
const ORACLE = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const NEIGHBOUR = `${ROOT}/samples/circuit-ncs/stranglehold-neighbour-2026-07-30`;
const TEMPLATE = `${ROOT}/samples/circuit-tracks/blank_slot20.ncs`;
const CHAIN_TABLE_BASE = 0x2c4;
const NOTE_CHAIN_INDEX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };

const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/stranglehold-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; pc: number; chain: [number, number];
  order: string[]; sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

let failures = 0;
const fail = (m: string): void => { failures++; console.log(`  FAIL: ${m}`); };
const ok = (m: string): void => console.log(`  ok: ${m}`);
const info = (m: string): void => console.log(`  info: ${m}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const tmpl = readFileSync(TEMPLATE);
const patchEq = (buf: Buffer, off: number): boolean => buf.subarray(off, off + 340).equals(tmpl.subarray(off, off + 340));
const findFile = (dir: string, slot: number): string => {
  const f = readdirSync(dir).find((x) => x.endsWith('.ncs') && new RegExp(`project0*${slot}-`).test(x));
  if (f === undefined) throw new Error(`no .ncs for slot ${slot} in ${dir}`);
  return path.join(dir, f);
};

/** A decoded pattern as a comparable cell list. */
interface Cell { step: number; notes: number[]; vel: number; gate: number; tie: boolean }
const decodeCells = (u8: Uint8Array, track: NoteTrack, p: number): Cell[] => {
  const out: Cell[] = [];
  for (const [i, s] of decodeNotePattern(u8, track, p).entries()) {
    if (!s.active || s.notes.length === 0) continue;
    out.push({ step: i, notes: s.notes.map((n) => n.note), vel: s.notes[0].velocity, gate: s.notes[0].gate, tie: s.notes.some((n) => n.tie) });
  }
  return out;
};

// ── the drone's TWO cell shapes, taken from the ORACLE'S OWN BYTES ────
console.log('=== drone reference cells, decoded from the carry-over oracle ===');
const oracle1 = readFileSync(`${ORACLE}/proj01__00_SESSION.ncs`) as unknown as Uint8Array;
const oracle2 = readFileSync(`${ORACLE}/proj02__01_SESSION.ncs`) as unknown as Uint8Array;
const CELL_PLAIN = decodeCells(oracle1, 'midi1', 0);   // slot 1 p1 = PLAIN
const CELL_TURN = decodeCells(oracle2, 'midi1', 2);    // slot 2 p3 = TURN
const cellSig = (c: Cell[]): string => JSON.stringify(c);
console.log(`  PLAIN (oracle slot 1 p1): ${CELL_PLAIN.map((c) => `${c.step}:${c.notes.join('+')} v${c.vel} g${c.gate}${c.tie ? ' TIE' : ''}`).join('  ')}`);
console.log(`  TURN  (oracle slot 2 p3): ${CELL_TURN.map((c) => `${c.step}:${c.notes.join('+')} v${c.vel} g${c.gate}${c.tie ? ' TIE' : ''}`).join('  ')}`);
if (cellSig(CELL_PLAIN) !== cellSig(CELL_TURN)) ok('the two oracle drone cells are distinct');
else fail('the two oracle reference cells are identical — reference extraction is wrong');
/** The intended per-slot drone sequence (staging §F). */
const DRONE_SEQ: Record<number, string> = { 1: 'PPPP', 2: 'PPTPPPTP', 3: 'PP', 4: 'PTPTPTPP', 5: 'PTPT', 6: 'PPPT' };

// ── per-slot verification ────────────────────────────────────────────
for (const st of STAGED) {
  const slot = st.slot;
  console.log(`\n=== slot ${slot} "${st.project_name}" (PC ${st.pc}) ===`);
  const buf = readFileSync(findFile(AUTHORED, slot));
  const u8 = buf as unknown as Uint8Array;
  const n = st.order.length;

  // meta
  const name = getProjectName(u8);
  const meta: Array<[string, boolean, string]> = [
    [`name "${st.project_name}"`, name === st.project_name, `got "${name}"`],
    ['colour 2 (Peach) @0x0c', buf[0x0c] === 2, `got ${buf[0x0c]}`],
    ['tempo 72 @0x34', buf[0x34] === 72, `got ${buf[0x34]}`],
    ['swing 50 @0x35', buf[0x35] === 50, `got ${buf[0x35]}`],
    ['scale Chromatic 0/15', buf[0x26d0c] === 0 && buf[0x26d0d] === 15, `got ${buf[0x26d0c]}/${buf[0x26d0d]}`],
    ['synth levels 0/0 @0x2701c/d', buf[0x2701c] === 0 && buf[0x2701d] === 0, `got ${buf[0x2701c]}/${buf[0x2701d]}`],
    ['drum levels 0 x4', [0, 1, 2, 3].every((d) => buf[0x26fbd + d * 11] === 0), `got [${[0, 1, 2, 3].map((d) => buf[0x26fbd + d * 11])}]`],
    ['patch bodies == blank_slot20 template', patchEq(buf, 0x26d14) && patchEq(buf, 0x26e68), 'differ'],
    ['NO scene table (plain chain)', getSceneChainEnd(u8) === undefined, `sceneEnd ${getSceneChainEnd(u8)}`],
  ];
  const badMeta = meta.filter(([, v]) => !v);
  if (badMeta.length === 0) ok(`meta clean: Peach, 72 BPM, swing 50, Chromatic, synths 0/0, drums 0 x4, template patches, no scene table`);
  else for (const [k, , d] of badMeta) fail(`${k} — ${d}`);

  // chains
  const chainOf = (tr: string): [number, number] => {
    const off = CHAIN_TABLE_BASE + NOTE_CHAIN_INDEX[tr] * 4;
    return [buf[off], buf[off + 1]];
  };
  const c2 = chainOf('midi2'); const c1 = chainOf('midi1');
  if (eq(c2, st.chain)) ok(`midi2 chain [${c2}] == §1`);
  else fail(`midi2 chain [${c2}] != [${st.chain}]`);
  if (eq(c1, st.chain)) ok(`midi1 chain [${c1}] == midi2's — the DRONE is IN PHASE with the kit (the oracle's out-of-phase [0,7] artifact is resolved, §3 row 13)`);
  else fail(`midi1 chain [${c1}] != [${st.chain}]`);
  for (const tr of ['synth1', 'synth2']) {
    const ch = chainOf(tr);
    if (eq(ch, [0, 0])) ok(`${tr} chain [0,0] (unauthored)`);
    else fail(`${tr} chain [${ch}] — should be untouched [0,0]`);
  }

  // length bytes: 32 on EVERY chained pattern (incl. rests)
  const lens = [...Array(8)].map((_, p) => buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1);
  const chained = lens.slice(0, n);
  if (chained.every((x) => x === 32)) ok(`length byte 32 on all ${n} chained midi2 patterns (incl. the rest patterns — the length-byte trap: an unset length plays 16)`);
  else fail(`chained midi2 lengths [${chained}] — not all 32`);
  const lens1 = [...Array(8)].map((_, p) => buf[META_OFFSETS[noteBlockIndex('midi1', p)]] + 1).slice(0, n);
  if (lens1.every((x) => x === 32)) ok(`length byte 32 on all ${n} chained midi1 (drone) patterns`);
  else fail(`chained midi1 lengths [${lens1}] — not all 32`);

  // FULL per-step midi2 decode == staged rows
  let stepMismatch = 0;
  const noteSet = new Set<number>();
  for (let p = 0; p < n; p++) {
    const sec = st.sections.find((s) => s.name === st.order[p])!;
    const want = new Map<number, Array<{ note: number; vel: number }>>();
    for (const [voice, row] of Object.entries(sec.voices)) {
      if (voice === 'midi1') continue;
      row.split(/\s+/).forEach((tok, i) => {
        if (tok === '~') return;
        const vel = Number(/@(\d+)$/.exec(tok)![1]);
        (want.get(i) ?? want.set(i, []).get(i)!).push({ note: GM12[voice], vel });
      });
    }
    const got = new Map<number, Array<{ note: number; vel: number }>>();
    for (const [i, s] of decodeNotePattern(u8, 'midi2', p).entries()) {
      if (!s.active) continue;
      for (const nn of s.notes) {
        (got.get(i) ?? got.set(i, []).get(i)!).push({ note: nn.note, vel: nn.velocity });
        noteSet.add(nn.note);
      }
    }
    const norm = (m: Map<number, Array<{ note: number; vel: number }>>): string => JSON.stringify(
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v.slice().sort((x, y) => x.note - y.note || x.vel - y.vel)]));
    if (norm(want) !== norm(got)) {
      stepMismatch++;
      fail(`slot ${slot} pattern ${p + 1} ("${sec.name}") midi2 decode != staged rows`);
      console.log(`      want ${norm(want).slice(0, 400)}`);
      console.log(`      got  ${norm(got).slice(0, 400)}`);
    }
  }
  if (stepMismatch === 0) ok(`FULL per-step midi2 decode == the staged rows on all ${n} patterns (note + velocity per step)`);

  // stored note set
  const ns = [...noteSet].sort((a, b) => a - b);
  if (ns.every((x) => [48, 50, 54, 57, 58, 61, 63].includes(x))) ok(`stored note set {${ns.join(',')}} ⊆ {48,50,54,57,58,61,63}; ZERO 51, ZERO 68`);
  else fail(`stored note set {${ns.join(',')}} escapes the kit-40 set`);

  // THE DRONE
  const seq: string[] = [];
  let droneBad = 0;
  for (let p = 0; p < n; p++) {
    const cells = decodeCells(u8, 'midi1', p);
    const sig = cellSig(cells);
    if (sig === cellSig(CELL_PLAIN)) seq.push('P');
    else if (sig === cellSig(CELL_TURN)) seq.push('T');
    else { seq.push('?'); droneBad++; fail(`slot ${slot} midi1 pattern ${p + 1} matches NEITHER oracle drone cell: ${sig.slice(0, 300)}`); }
  }
  if (droneBad === 0 && seq.join('') === DRONE_SEQ[slot])
    ok(`THE DRONE decodes back off the card: ${seq.join('')} — every pattern is byte-identical to an ORACLE cell (E3+B3 v100, PLAIN g96 tied / TURN g84+g60(+Bb)+g48)`);
  else fail(`drone sequence ${seq.join('')} != intended ${DRONE_SEQ[slot]}`);

  // the other tracks are empty
  for (const tr of ['synth1', 'synth2'] as NoteTrack[]) {
    let onsets = 0;
    for (let p = 0; p < 8; p++) for (const s of decodeNotePattern(u8, tr, p)) if (s.active) onsets += s.notes.length;
    if (onsets === 0) ok(`${tr} EMPTY`);
    else fail(`${tr} has ${onsets} onsets`);
  }
  let drumHits = 0;
  for (let d = 0; d < 4; d++) for (let p = 0; p < 8; p++) for (const s of decodeDrumPattern(u8, d, p)) if (s.active) drumHits++;
  if (drumHits === 0) ok('internal drum tracks 1-4 EMPTY (external-only to the SPD-SX)');
  else fail(`internal drums have ${drumHits} active steps`);
  if (NOTE_TRACKS.length > 0) { /* keep the import meaningful */ }
}

// ── §3 tail assertions, on the DECODED card bytes ────────────────────
console.log('\n=== §3 tail assertions, re-run on the decoded card bytes ===');
const cardCells = (slot: number, p: number): Cell[] => decodeCells(readFileSync(findFile(AUTHORED, slot)) as unknown as Uint8Array, 'midi2', p);
const flat = (cs: Cell[]): string[] => cs.flatMap((c) => c.notes.map((nn) => `${c.step}:${nn}@${c.vel}`)).sort((a, b) => (Number.parseInt(a, 10) - Number.parseInt(b, 10)) || a.localeCompare(b));
{
  if (cardCells(1, 0).length === 0 && cardCells(1, 1).length === 0) ok('P1 p1-p2 midi2 EMPTY (the drone rides them)');
  else fail('P1 p1-p2 carry midi2 content');
  const p3 = flat(cardCells(1, 2));
  if (eq(p3, ['28:48@100', '28:61@100', '30:48@100', '30:61@100'])) ok(`P1 p3 == the RESTORED m6 band hits (crash+kick @28,@30): [${p3.join(' ')}]`);
  else fail(`P1 p3 = [${p3.join(' ')}]`);
  const p4 = flat(cardCells(1, 3));
  const sn127 = p4.filter((x) => x.includes(':50@127')).map((x) => Number.parseInt(x, 10));
  if (eq(sn127, [9, 12, 15, 18, 20, 24])) ok('P1 p4 == the famous fill, snare accents @9,12,15,18,20,24 at v127');
  else fail(`P1 p4 snare accents [${sn127}]`);
  const p2p8 = flat(cardCells(2, 7));
  if (eq(p2p8.filter((x) => x.startsWith('0:')), ['0:48@100', '0:54@100'])) ok('P2 p8 head == kick+hat, NO crash (wrap-neutral)');
  else fail(`P2 p8 head [${p2p8.filter((x) => x.startsWith('0:')).join(' ')}]`);
  if (p2p8.some((x) => x.includes('@75'))) ok('P2 p8 press-roll keeps its v75 doubles (dynamics stored, not flattened)');
  else fail('P2 p8 has no v75 cells');
  const p2p4 = flat(cardCells(2, 3));
  const toms = p2p4.filter((x) => x.includes(':57@')).map((x) => Number.parseInt(x, 10));
  if (eq(toms, [25, 26, 27, 28, 29, 30, 31]) && p2p4.some((x) => x === '24:58@100')) ok('P2 p4 tail == openhat@24 + tom run @25-31');
  else fail(`P2 p4 tail toms [${toms}]`);
  const p3p1 = flat(cardCells(3, 0));
  const tiers = new Set(p3p1.filter((x) => x.includes(':63@')).map((x) => x.split('@')[1]));
  if (eq(p3p1.filter((x) => x.startsWith('0:')), ['0:48@100', '0:61@100'])) ok('P3 p1 head == crash+kick @0');
  else fail(`P3 p1 head [${p3p1.filter((x) => x.startsWith('0:')).join(' ')}]`);
  if (tiers.has('127') && tiers.has('120')) ok(`P3 p1 ride carries BOTH accent tiers {${[...tiers].sort().join(',')}}`);
  else fail(`P3 p1 ride tiers {${[...tiers].join(',')}}`);
  const p3p2 = flat(cardCells(3, 1)).filter((x) => x.includes(':50@127') && Number.parseInt(x, 10) >= 28);
  if (eq(p3p2, ['28:50@127', '30:50@127'])) ok('P3 p2 tail == the RESTORED m36 exit fill');
  else fail(`P3 p2 exit fill [${p3p2.join(' ')}]`);
  for (const p of [0, 2, 4, 6]) {
    if (!flat(cardCells(4, p)).some((x) => x.includes(':61@'))) continue;
    fail(`P4 pattern ${p + 1} carries a crash (should be plain C)`);
  }
  ok('P4 p1/p3/p5/p7 == plain C, no crash');
  const p5p3 = flat(cardCells(5, 2));
  if (p5p3.some((x) => x === '0:61@100') && eq(p5p3.filter((x) => x.includes(':50@127')).map((x) => Number.parseInt(x, 10)), [12, 13]))
    ok('P5 p3 == crash@0 + double-snare accents @12,13');
  else fail(`P5 p3 [${p5p3.slice(0, 12).join(' ')}]`);
  const p5p4 = flat(cardCells(5, 3));
  if (p5p4.some((x) => x === '16:61@100') && eq(p5p4.filter((x) => x.includes(':50@127')).map((x) => Number.parseInt(x, 10)), [0, 1, 4, 5, 8, 9, 12, 13]))
    ok('P5 p4 == the m127-128 figure (accented snare pairs + crash@16)');
  else fail(`P5 p4 [${p5p4.slice(0, 12).join(' ')}]`);
  if (cardCells(6, 2).length === 0) ok('P6 p3 midi2 EMPTY — the 2-bar silence is load-bearing time (chained at length 32, drone riding)');
  else fail('P6 p3 carries midi2 content');
  const p6p4 = flat(cardCells(6, 3));
  if (eq(p6p4, ['0:48@100', '0:61@100'])) ok(`P6 p4 == the RESTORED m151 final hit: crash+kick @0 and NOTHING else`);
  else fail(`P6 p4 = [${p6p4.join(' ')}]`);
}

// ── neighbour identity ───────────────────────────────────────────────
console.log('\n=== neighbour identity (nothing else on the card moved) ===');
for (const [slot, canonDir, label] of [
  [9, `${ROOT}/samples/circuit-ncs/amber-authored-2026-07-29`, 'Amber 01 Intro'],
  [27, `${ROOT}/samples/circuit-ncs/clint-authored-2026-07-30`, 'Clint 01 Intro'],
  [46, `${ROOT}/samples/circuit-ncs/sugar-authored-2026-07-30`, 'Sugar 1 IntroVrs'],
] as Array<[number, string, string]>) {
  const a = readFileSync(findFile(NEIGHBOUR, slot));
  const b = readFileSync(findFile(canonDir, slot));
  if (a.equals(b)) ok(`slot ${slot} ${label}: BYTE-IDENTICAL to its canonical — untouched`);
  else fail(`slot ${slot} ${label} DIFFERS from its canonical`);
}
try {
  const bd = readFileSync(findFile(NEIGHBOUR, 35));
  const cl = readFileSync(findFile(`${ROOT}/samples/circuit-ncs/clint-neighbour-2026-07-30`, 35));
  info(`slot 35 Breakdown P1 vs the 18:19 capture: ${bd.equals(cl) ? 'identical' : 'DIFFERS (concurrent surgical work — reported, not gated)'}`);
} catch { info('slot 35 comparison skipped'); }

console.log(`\n${failures === 0 ? 'PHASE 4 VERIFY PASS — 6/6' : `${failures} FAILURES`}`);
process.exitCode = failures === 0 ? 0 : 1;
