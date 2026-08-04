/**
 * POPULATE pass Phase 4 — DECODE verification, offline, from the downloaded
 * bytes only. Run AFTER populate-exec.ts backup.
 *   npx tsx samples/_scratch/populate-verify.ts
 *
 * The five questions the brief asks, per project:
 *
 *  (a) Are the internal drum steps a FAITHFUL FOLD of that project's own MIDI 2
 *      drum content? Two legs, both from bytes:
 *        a1  the file's stored midi2 note set, step by step, equals the staged
 *            roles through the SPD-SX GM+12 map (so the external leg IS the
 *            drum content we claim to have folded);
 *        a2  the file's stored internal drum steps equal what the PRODUCT'S OWN
 *            condenser (`buildCondensedDrums`) produces from that same content
 *            — hits, velocities, and per-step sample flips.
 *      The fold map and every contention resolution are reported.
 *  (b) binding == [1,2,5,11].
 *  (c) all six stored mixer levels == 0.
 *  (d) every OTHER track byte-identical to the pre-write canonical. Checked two
 *      ways: an explicit per-track step-region compare for synth1/synth2/midi1/
 *      midi2 across all 8 patterns, AND a whole-file diff in which every single
 *      differing byte must fall inside a known drum-layer window. A byte that
 *      moves anywhere else fails the run.
 *  (e) six untouched neighbour projects, whole-file identical.
 */
import { readFileSync, readdirSync } from 'node:fs';
import {
  META_OFFSETS, NCS_FILE_SIZE, NOTE_STEP_REGION, drumBlockIndex, noteBlockIndex, noteStepBase,
  getProjectName, getProjectColour, getProjectTempo, getProjectSwing, getSynthLevel, getDrumLevel,
  type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { decodeDrumPattern, DEFAULT_DRUM_CHOICE } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getDrumSampleBinding, slotForFlipRole } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getNoteChain } from '../../packages/circuit-tracks/src/ncs/chain.js';
import { getSceneChainEnd, getSceneNoteChain, getSceneDrumChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
import { getProjectScale } from '../../packages/circuit-tracks/src/ncs/scale.js';
import { buildCondensedDrums } from '../../packages/core/src/protocol-generic/dispatcher/condenseDrums.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { canonicalRole } from '../../packages/core/src/protocol-generic/patterns/index.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../../packages/circuit-tracks/src/descriptor.js';
import type { NeutralPattern, Step } from '../../packages/core/src/protocol-generic/patterns/index.js';

const ROOT = 'C:/dev/mcp-midi-tools';
// Overridable so the script can be smoke-run against any pair of captures.
const POST = process.env.POPULATE_POST ?? `${ROOT}/samples/circuit-ncs/populate-authored-2026-07-30`;
const PRE = process.env.POPULATE_PRE ?? `${ROOT}/samples/circuit-ncs/populate-preauthor-2026-07-30`;
const BINDING = [1, 2, 5, 11];
const KIT: readonly string[] = ['kick', 'snare', 'closed_hat', 'ride'];
/** SPD-SX GM pad notes + the route's +12 note_offset (descriptor SPDSX_GM_NOTE). */
const NOTE_OF: Record<string, number> = {
  kick: 48, snare: 50, hat: 54, openhat: 58, clap: 51, tom: 57, ride: 63, crash: 61, perc: 68,
};

let failures = 0;
const fail = (m: string): void => { failures++; console.log(`  FAIL: ${m}`); };
const ok = (m: string): void => console.log(`  ok: ${m}`);
const info = (m: string): void => console.log(`  info: ${m}`);

interface StagedSection { name: string; steps?: number; voices: Record<string, string> }
interface StagedProject { slot: number; project_name: string; order: string[]; sections: StagedSection[] }
const load = (f: string): StagedProject[] => JSON.parse(readFileSync(`${ROOT}/samples/_scratch/${f}`, 'utf8')) as StagedProject[];
const SONGS: Array<{ song: string; slots: number[]; staged: StagedProject[] }> = [
  { song: 'Amber', slots: [9, 10, 11, 12], staged: load('amber-staged.json') },
  { song: 'Stranglehold', slots: [1, 2, 3, 4, 5, 6], staged: load('stranglehold-staged.json') },
  { song: 'Sugar', slots: [47, 48, 49, 50, 51, 52], staged: load('sugar-staged.json') },
];
const WITNESSES = [46, 53, 14, 27, 35, 57];

const dirMap = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(`${dir}/${f}`));
  }
  return m;
};
const post = dirMap(POST);
const pre = dirMap(PRE);

// ── The byte windows a condensed-drum populate is ALLOWED to move ────────────
//
// Everything else in the file — the two synth tracks, the two MIDI tracks, the
// synth patch bodies, the project header, the note-track chain slots and every
// scene's NOTE selections — must be untouched.
const DRUM_AREA_START = META_OFFSETS[16] - 144;      // first drum block's step region
const DRUM_AREA_END = noteStepBase('midi1', 0);      // = 0x1a27c; the drum area ends where midi1 begins
const CHAIN_DRUM_START = 0x2c4 + 4 * 4;              // active chain table, drum slots 4..7
const CHAIN_DRUM_END = CHAIN_DRUM_START + 4 * 4;
const SCENE_BLOCK_BASE = 0x50; const SCENE_BLOCK_STRIDE = 0x28; const MAX_SCENES = 16;
const allowed: Array<[number, number, string]> = [
  [DRUM_AREA_START, DRUM_AREA_END, 'drum step + metadata area (incl. drum_binding @0x1a278)'],
  [CHAIN_DRUM_START, CHAIN_DRUM_END, 'active chain table, drum slots'],
  [0x2c1, 0x2c2, 'scene-chain end byte'],
  // 0x26fc7 = chain.ts CHAIN_TAIL_OFFSET, the drum-chain ENABLE tail, set to
  // 0x0c by setDrumChain. It moves 2 → 12 on exactly the projects that gain a
  // drum chain, which is every project in this pass and no other. The
  // 2026-07-30 drum-levels audit measured the same value independently: 12 on
  // all 72 authored projects, 2 on templates. (It lives inside the Drum-1
  // record's unexplained index-10 byte, which is why the binding pass was right
  // never to write it there — a binding edit has no drum chain to enable.)
  [0x26fc7, 0x26fc8, 'drum-chain enable tail (0x26fc7 → 0x0c)'],
  [0x26fbc, 0x26fbd, 'scene-state A'],
  [0x26fd2, 0x26fd3, 'scene-state B'],
];
for (let s = 0; s < MAX_SCENES; s++) {
  const b = SCENE_BLOCK_BASE + s * SCENE_BLOCK_STRIDE;
  allowed.push([b, b + 0x10, `scene ${s + 1} DRUM chain slots`]);
  allowed.push([b + 0x10, b + 0x11, `scene ${s + 1} defined flag`]);
}
for (let t = 0; t < 4; t++) allowed.push([0x26fbd + t * 11, 0x26fbe + t * 11, `Drum ${t + 1} stored level`]);
const regionOf = (off: number): string | undefined => allowed.find(([a, b]) => off >= a && off < b)?.[2];

/** Build the neutral pattern one staged section describes (drum voices only, plus melodic rows). */
const patternOf = (sec: StagedSection): NeutralPattern => ({
  name: sec.name, steps: sec.steps ?? 32,
  voices: Object.fromEntries(Object.entries(sec.voices).map(([v, row]) => [v, { steps: parseVoice(row, sec.steps ?? 32) }])),
});

console.log('=== POPULATE Phase 4: decode verification ===');
for (const song of SONGS) {
  console.log(`\n########## ${song.song} ##########`);
  for (const slot of song.slots) {
    const st = song.staged.find((x) => x.slot === slot)!;
    const a = post.get(slot); const b = pre.get(slot);
    if (a === undefined || b === undefined) { fail(`slot ${slot}: missing ${a === undefined ? 'post' : 'pre'} capture`); continue; }
    if (a.length !== NCS_FILE_SIZE || b.length !== NCS_FILE_SIZE) { fail(`slot ${slot}: wrong file size`); continue; }
    console.log(`\n--- slot ${slot} "${getProjectName(a)}" ---`);

    // ── (d1) whole-file diff, every differing byte classified ────────────────
    const byRegion = new Map<string, number>();
    let stray = 0; let firstStray = -1;
    for (let i = 0; i < NCS_FILE_SIZE; i++) {
      if (a[i] === b[i]) continue;
      const r = regionOf(i);
      if (r === undefined) { stray++; if (firstStray < 0) firstStray = i; continue; }
      byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    const total = [...byRegion.values()].reduce((x, y) => x + y, 0) + stray;
    if (stray === 0) ok(`(d) ${total} bytes changed, ALL inside the drum layer: ${[...byRegion].map(([r, n]) => `${n}× ${r}`).join('; ')}`);
    else fail(`(d) ${stray} byte(s) changed OUTSIDE the drum layer, first at 0x${firstStray.toString(16)} (${b[firstStray]}→${a[firstStray]})`);

    // ── (d2) explicit per-track identity for every melodic/MIDI track ────────
    let trackBad = 0;
    for (const tr of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
      for (let p = 0; p < 8; p++) {
        const off = noteStepBase(tr, p);
        if (!a.subarray(off, off + NOTE_STEP_REGION).equals(b.subarray(off, off + NOTE_STEP_REGION))) {
          fail(`(d) ${tr} pattern ${p + 1} step region MOVED`); trackBad++;
        }
        const mo = META_OFFSETS[noteBlockIndex(tr, p)];
        if (a[mo] !== b[mo]) { fail(`(d) ${tr} pattern ${p + 1} length byte moved ${b[mo]}→${a[mo]}`); trackBad++; }
      }
    }
    if (trackBad === 0) ok('(d) synth1 / synth2 / midi1 / midi2: all 32 step regions + length bytes byte-identical to the pre-write canonical');

    // ── (d3) header + chain/scene shape identity ─────────────────────────────
    const hdr: Array<[string, unknown, unknown]> = [
      ['name', getProjectName(a), getProjectName(b)],
      ['colour', getProjectColour(a), getProjectColour(b)],
      ['tempo', getProjectTempo(a), getProjectTempo(b)],
      ['swing', getProjectSwing(a), getProjectSwing(b)],
      ['scale', JSON.stringify(getProjectScale(a)), JSON.stringify(getProjectScale(b))],
      ['synth1 level', getSynthLevel(a, 1), getSynthLevel(b, 1)],
      ['synth2 level', getSynthLevel(a, 2), getSynthLevel(b, 2)],
      ['scene chain end', getSceneChainEnd(a), getSceneChainEnd(b)],
      ...(['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]).map((tr) =>
        [`${tr} chain`, JSON.stringify(getNoteChain(a, tr)), JSON.stringify(getNoteChain(b, tr))] as [string, unknown, unknown]),
    ];
    const sceneEnd = getSceneChainEnd(a);
    if (sceneEnd !== undefined) {
      for (let s = 0; s < sceneEnd; s++) {
        for (const tr of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
          hdr.push([`scene ${s + 1} ${tr}`, JSON.stringify(getSceneNoteChain(a, tr, s)), JSON.stringify(getSceneNoteChain(b, tr, s))]);
        }
      }
    }
    const hdrBad = hdr.filter(([, x, y]) => JSON.stringify(x) !== JSON.stringify(y));
    if (hdrBad.length === 0) ok(`(d) header + note-track chain/scene shape unchanged (colour ${getProjectColour(a)}, tempo ${getProjectTempo(a)}, ${sceneEnd !== undefined ? `${sceneEnd} scenes` : `chain ${JSON.stringify(getNoteChain(a, 'midi2'))}`})`);
    else for (const [k, x, y] of hdrBad) fail(`(d) ${k} MOVED: ${JSON.stringify(y)} → ${JSON.stringify(x)}`);

    // ── (b) binding, (c) levels ─────────────────────────────────────────────
    const bind = getDrumSampleBinding(a);
    if (JSON.stringify(bind) === JSON.stringify(BINDING)) ok(`(b) drum binding [${bind}]`);
    else fail(`(b) drum binding [${bind}], expected [${BINDING}]`);
    const levels = [getSynthLevel(a, 1), getSynthLevel(a, 2), ...[0, 1, 2, 3].map((t) => getDrumLevel(a, t))];
    if (levels.every((l) => l === 0)) ok('(c) all six stored mixer levels are 0 (stored-silent)');
    else fail(`(c) stored levels ${levels.join('/')} — not all silent`);

    // ── (a) the fold ────────────────────────────────────────────────────────
    // Which pattern SLOT each section occupies: a plain chain gives one slot per
    // PLAY (sections repeat into their own slots); a scene layout gives one slot
    // per distinct section, in listed order.
    const names = st.sections.map((s) => s.name);
    const idx = st.order.map((n) => names.indexOf(n));
    const chained = st.order.length <= 8;
    const slotSections = chained ? idx.map((i) => st.sections[i]) : st.sections;

    const foldHits = new Map<string, Map<string, number>>();   // source role → track role → hits
    let collisions = 0; let flipsExpected = 0; let flipsSeen = 0;
    let a1Bad = 0; let a2Bad = 0; let internalHits = 0; let externalHits = 0;
    for (let p = 0; p < slotSections.length; p++) {
      const sec = slotSections[p];
      const pat = patternOf(sec);
      const drumVoices = Object.keys(pat.voices).filter((v) => canonicalRole(v) !== undefined);

      // a1: the file's own midi2 must be exactly this section's drum content.
      const m2 = decodeNotePattern(a, 'midi2', p);
      for (let s = 0; s < 32; s++) {
        const roles = drumVoices.filter((v) => pat.voices[v].steps[s]?.on === true);
        const want = roles.map((r) => NOTE_OF[r]).sort((x, y) => x - y);
        const got = m2[s].notes.map((n) => n.note).sort((x, y) => x - y);
        externalHits += got.length;
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          if (a1Bad === 0) fail(`(a1) pattern ${p + 1} step ${s + 1}: staged [${roles}] → [${want}], stored midi2 holds [${got}]`);
          a1Bad++;
        }
      }

      // a2: the internal tracks must be the product condenser's own answer.
      const cd = buildCondensedDrums(pat, CIRCUIT_TRACKS_DESCRIPTOR.capabilities);
      for (let t = 0; t < 4; t++) {
        const rows = decodeDrumPattern(a, t, p);
        const want: Step[] | undefined = cd?.voices[`condense:drum${t + 1}`]?.steps;
        for (let s = 0; s < 32; s++) {
          const on = rows[s].active;
          const wOn = want?.[s]?.on === true;
          if (on) internalHits++;
          if (on !== wOn) {
            if (a2Bad === 0) fail(`(a2) Drum${t + 1} pattern ${p + 1} step ${s + 1}: stored ${on ? 'HIT' : 'rest'}, condenser says ${wOn ? 'HIT' : 'rest'}`);
            a2Bad++;
            continue;
          }
          if (!on) continue;
          const wVel = want![s].velocity ?? 100;
          if (rows[s].velocity !== wVel) {
            if (a2Bad === 0) fail(`(a2) Drum${t + 1} pattern ${p + 1} step ${s + 1}: velocity ${rows[s].velocity}, condenser says ${wVel}`);
            a2Bad++;
          }
          // Per-step sample flip: resolved against the BOUND slots; a piece
          // outside the four bound roles is unlocatable in this pack's pool and
          // must be SKIPPED (no flip), never guessed at the canonical layout.
          const role = cd?.flip_roles[`drum${t + 1}`]?.[String(s + 1)];
          const wantSlot = role === undefined ? undefined : slotForFlipRole(role, BINDING);
          const wantChoice = wantSlot ?? DEFAULT_DRUM_CHOICE;
          if (role !== undefined) flipsExpected++;
          if (rows[s].drumChoice !== wantChoice) {
            if (a2Bad === 0) fail(`(a2) Drum${t + 1} pattern ${p + 1} step ${s + 1}: sample flip ${rows[s].drumChoice}, expected ${wantChoice}${role ? ` (role "${role}")` : ''}`);
            a2Bad++;
          } else if (rows[s].drumChoice !== DEFAULT_DRUM_CHOICE) flipsSeen++;
          if (rows[s].drumChoice !== DEFAULT_DRUM_CHOICE && !BINDING.includes(rows[s].drumChoice)) {
            fail(`(a2) Drum${t + 1} pattern ${p + 1} step ${s + 1}: sample flip ${rows[s].drumChoice} is OUTSIDE the bound pool [${BINDING}]`);
          }
        }
      }
      if (cd !== undefined) {
        collisions += cd.collisions;
        // Fold map: every source drum voice, and which kit track its hits landed on.
        for (const v of drumVoices) {
          const hits = pat.voices[v].steps.filter((s) => s.on).length;
          if (hits === 0) continue;
          const role = canonicalRole(v)!;
          const track = KIT.includes(role) ? role : undefined;
          const m = foldHits.get(v) ?? new Map<string, number>();
          // A voice that is itself a kit role stays on its own track; anything
          // else was folded, and the flip map names where each hit landed.
          let landed = track;
          if (landed === undefined) {
            for (let t = 0; t < 4; t++) {
              if (cd.flip_roles[`drum${t + 1}`] !== undefined
                && Object.values(cd.flip_roles[`drum${t + 1}`]).includes(role)) { landed = KIT[t]; break; }
            }
          }
          m.set(landed ?? '(masked)', (m.get(landed ?? '(masked)') ?? 0) + hits);
          foldHits.set(v, m);
        }
      }
    }
    // Sugar's china/crash stop-ship, asserted on EVERY song (it costs nothing
    // and a stray 51/68 would mean a kit-40 pad we never authorized): the
    // stored external leg must hold no clap (51) and no perc (68). The internal
    // layer inherits the same guarantee because it is a fold of these voices
    // and its sample flips are checked against the bound pool below.
    {
      const strayNotes = new Set<number>();
      for (let p = 0; p < slotSections.length; p++) {
        for (const s of decodeNotePattern(a, 'midi2', p)) for (const n of s.notes) if (n.note === 51 || n.note === 68) strayNotes.add(n.note);
      }
      if (strayNotes.size === 0) ok('(a1) stop-ship: zero stored 51 (clap) and zero stored 68 (perc) anywhere in midi2');
      else fail(`(a1) STOP-SHIP: stored midi2 holds note(s) ${[...strayNotes]}`);
    }
    if (a1Bad === 0) ok(`(a1) stored midi2 == this project's staged drum content on every step (${externalHits} hits across ${slotSections.length} patterns)`);
    else fail(`(a1) ${a1Bad} midi2 step(s) differ from the staged drum content`);
    if (a2Bad === 0) ok(`(a2) internal Drum1-4 == the condenser's fold of that same content (${internalHits} hits, ${flipsSeen}/${flipsExpected} sample flips landed inside the bound pool)`);
    else fail(`(a2) ${a2Bad} internal drum step(s) differ from the condenser's answer`);
    info(`fold map: ${[...foldHits].map(([v, m]) => `${v}(${[...m.values()].reduce((x, y) => x + y, 0)})→${[...m.keys()].join('+')}`).join(', ')}`);
    if (collisions > 0) info(`contention: ${collisions} step(s) had two same-family pieces on one track; the louder hit kept the step`);
    if (flipsExpected > flipsSeen) info(`${flipsExpected - flipsSeen} flip(s) skipped: the folded piece is not in pack 5's pool under binding [${BINDING}], so the hit keeps its track's bound sound`);

    // Drum chain wiring is NEW (the tracks did not exist before); report it.
    const dchain = getSceneChainEnd(a) === undefined
      ? JSON.stringify(getNoteChain(a, 'midi2'))
      : `${getSceneChainEnd(a)} scenes, drum1 scene1=${JSON.stringify(getSceneDrumChain(a, 0, 0))}`;
    info(`drum advance wiring now present: ${dchain}`);
  }
}

// ── (e) untouched neighbours ────────────────────────────────────────────────
console.log('\n########## (e) untouched neighbours ##########');
for (const slot of WITNESSES) {
  const a = post.get(slot); const b = pre.get(slot);
  if (a === undefined || b === undefined) { fail(`witness slot ${slot}: missing capture`); continue; }
  if (a.equals(b)) ok(`slot ${slot} "${getProjectName(a)}" byte-identical across all ${NCS_FILE_SIZE} bytes`);
  else fail(`slot ${slot} "${getProjectName(a)}" MOVED — the write touched something it was not aimed at`);
}

console.log(`\n${failures === 0 ? 'PHASE 4 PASS — 16/16 populated, nothing else moved' : `${failures} FAILURES`}`);
process.exitCode = failures === 0 ? 0 : 1;
