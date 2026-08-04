/**
 * I BELIEVE — populate PHASE 4 VERIFICATION. OFFLINE, READ-ONLY.
 *
 * Compares the post-write download (`ibelieve-authored-2026-07-31`) against the
 * pre-write canonical (`ibelieve-preauthor-2026-07-31`, itself gate-proved
 * byte-identical to the campaign canonical) and answers, per project:
 *
 *   (a) the internal drum layer EQUALS the condenser's own answer for that
 *       project's own midi2 content (recomputed here from the PRE-WRITE bytes,
 *       through the product's `condenseToKit`) — on/off + velocity + length;
 *   (b) midi2 AND every melodic track (synth1/2, midi1) byte-identical to
 *       pre-write, chain slots included, plus the whole scene stack;
 *   (c) binding [1,2,5,11];
 *   (d) all six stored levels 0;
 *   (e) every byte outside the DRUM regions identical to pre-write — the whole
 *       160,780, region-classified, so anything unexpected is named;
 *   (f) the two untouched neighbours byte-identical.
 *
 * Run: npx tsx scripts/_research/campaign-2026-07/ibelieve-verify.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
  drumBlockIndex, noteBlockIndex, getProjectName, getProjectColour, projectColourName,
  getProjectTempo, checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';
import { condenseToKit, type NeutralPattern, type Step } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const PRE = `${ROOT}/samples/circuit-ncs/ibelieve-preauthor-2026-07-31`;
const POST = `${ROOT}/samples/circuit-ncs/ibelieve-authored-2026-07-31`;
const TARGETS = [19, 20, 21, 22, 23, 24, 25];
const WITNESSES = [17, 27];
const BINDING = [1, 2, 5, 11];
const KIT = ['kick', 'snare', 'closed_hat', 'ride'] as const;

const SPDSX_GM: Record<string, number> = { kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56 };
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]));

let failures = 0;
const fail = (m: string): void => { failures++; console.log(`FAIL: ${m}`); };
const ok = (m: string): void => console.log(`  ok: ${m}`);

function load(dir: string): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project0*(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), new Uint8Array(readFileSync(path.join(dir, f))));
  }
  return m;
}

// ── Region classifier: which byte belongs to the DRUM layer? ────────────────
function drumRegions(): Array<{ from: number; to: number; what: string }> {
  const r: Array<{ from: number; to: number; what: string }> = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const meta = META_OFFSETS[drumBlockIndex(t, p)];
      const prev = p === 0 && t === 0 ? undefined : META_OFFSETS[drumBlockIndex(t, p) - 1];
      r.push({ from: prev === undefined ? meta - 0x200 : prev + 1, to: meta, what: `drum${t + 1} pattern ${p + 1} steps+length` });
    }
  }
  r.push({ from: 0x2d4, to: 0x2e3, what: 'drum chain slots (0x2c4 table, slots 4-7)' });
  // setDrumChain's CHAIN_TAIL byte: shipped behaviour of the drum-chain
  // primitive, carried by every other project populated in this campaign.
  r.push({ from: 0x26fc7, to: 0x26fc7, what: 'drum chain tail 0x26fc7 (setDrumChain CHAIN_TAIL)' });
  r.push({ from: 0x1a278, to: 0x1a27b, what: 'drum sample binding' });
  for (let n = 0; n < 4; n++) r.push({ from: DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE, to: DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE, what: `drum${n + 1} stored level` });
  r.push({ from: MIXER_SYNTH1_LEVEL, to: MIXER_SYNTH2_LEVEL, what: 'synth stored levels (re-stamped to the 0 already held)' });
  return r;
}
const REGIONS = drumRegions();
const classify = (o: number): string | undefined => REGIONS.find((x) => o >= x.from && o <= x.to)?.what;

/** Rebuild the section's drum voices from a project's stored midi2 pattern. */
function voicesFromMidi2(buf: Uint8Array, pattern: number): NeutralPattern | undefined {
  const steps = decodeNotePattern(buf, 'midi2', pattern);
  const voices: Record<string, { steps: Step[] }> = {};
  let any = false;
  for (let s = 0; s < STEPS_PER_PATTERN; s++) {
    for (const n of steps[s].notes) {
      const v = STORED_TO_VOICE.get(n.note);
      if (v === undefined) continue;
      if (voices[v] === undefined) voices[v] = { steps: Array.from({ length: STEPS_PER_PATTERN }, () => ({ on: false } as Step)) };
      voices[v].steps[s] = { on: true, velocity: n.velocity } as Step;
      any = true;
    }
  }
  if (!any) return undefined;
  return { name: `p${pattern + 1}`, steps: STEPS_PER_PATTERN, voices };
}

const pre = load(PRE);
const post = load(POST);
const totals: Array<[number, number, string, number, number]> = [];

for (const slot of TARGETS) {
  const a = pre.get(slot); const b = post.get(slot);
  console.log(`\n===== Project ${slot} =====`);
  if (a === undefined || b === undefined) { fail(`slot ${slot}: missing ${a === undefined ? 'pre' : 'post'} capture`); continue; }
  if (b.length !== NCS_FILE_SIZE) { fail(`slot ${slot}: post is ${b.length} bytes`); continue; }
  const st = checkNcsStructure(b);
  if (st.ok) ok('structure ok'); else fail(`slot ${slot}: structure faults ${st.faults.join('; ')}`);

  // (c) binding, (d) levels
  const binding = getDrumSampleBinding(b);
  if (JSON.stringify(binding) === JSON.stringify(BINDING)) ok(`(c) binding [${binding.join(',')}]`);
  else fail(`slot ${slot}: (c) binding [${binding.join(',')}] != [${BINDING.join(',')}]`);
  const levels = [b[MIXER_SYNTH1_LEVEL], b[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => b[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
  if (levels.every((l) => l === 0)) ok('(d) all six stored levels 0 (silent)');
  else fail(`slot ${slot}: (d) levels [${levels.join(',')}] not all 0`);

  const meta: Array<[string, unknown, unknown]> = [
    ['name', getProjectName(a), getProjectName(b)],
    ['colour', projectColourName(getProjectColour(a)), projectColourName(getProjectColour(b))],
    ['tempo', getProjectTempo(a), getProjectTempo(b)],
  ];
  const metaBad = meta.filter(([, x, y]) => x !== y);
  if (metaBad.length === 0) ok(`name "${getProjectName(b)}" / colour ${projectColourName(getProjectColour(b))} / tempo ${getProjectTempo(b)} unchanged`);
  else fail(`slot ${slot}: metadata moved: ${metaBad.map(([k, x, y]) => `${k} ${String(x)}->${String(y)}`).join(', ')}`);

  // (b) scene stack byte-identical
  const sceneBytes: number[] = [];
  for (let sc = 0; sc < 16; sc++) for (let i = 0; i < 0x28; i++) sceneBytes.push(0x50 + sc * 0x28 + i);
  sceneBytes.push(0x2c1, 0x26fbc, 0x26fd2);
  const sceneDiff = sceneBytes.filter((o) => a[o] !== b[o]);
  if (sceneDiff.length === 0) ok(`(b1) scene stack byte-identical (${sceneBytes.length} bytes); scene chain ${getSceneChainEnd(b) ?? 'absent (as pre-write)'}`);
  else fail(`slot ${slot}: (b1) SCENE STACK MOVED at ${sceneDiff.map((o) => `0x${o.toString(16)}`).join(',')}`);

  // (b) every note track byte-identical, per track so a regression is named.
  let noteBad = 0;
  for (const track of ['synth1', 'synth2', 'midi1', 'midi2'] as const) {
    const bad: number[] = [];
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const meta2 = META_OFFSETS[noteBlockIndex(track, p)];
      for (let o = meta2 - 896; o <= meta2; o++) if (a[o] !== b[o]) bad.push(o);
    }
    let notes = 0;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const s of decodeNotePattern(b, track, p)) notes += s.notes.length;
    if (bad.length === 0) ok(`(b2) ${track} byte-identical (${notes} note(s) intact)`);
    else { fail(`slot ${slot}: (b2) ${track} MOVED at ${bad.slice(0, 8).map((o) => `0x${o.toString(16)}`).join(',')}${bad.length > 8 ? ` +${bad.length - 8}` : ''}`); noteBad += bad.length; }
  }
  const chainBad: number[] = [];
  for (let o = 0x2c4; o <= 0x2d3; o++) if (a[o] !== b[o]) chainBad.push(o);
  if (chainBad.length === 0) ok('(b3) note-track chain slots byte-identical, incl. the offset-721 byte');
  else fail(`slot ${slot}: (b3) note chain slots MOVED at ${chainBad.map((o) => `0x${o.toString(16)}`).join(',')}`);

  // (a) the condensed layer equals the condenser's own answer.
  const chain = getNoteChain(a, 'midi2')!;
  const written: number[] = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) if (decodeDrumPattern(b, t, p).some((c) => c.active)) { written.push(t); break; }
  }
  let mismatches = 0; let totalHits = 0; let collisions = 0;
  for (let p = 0; p <= chain.end; p++) {
    const np = voicesFromMidi2(a, p);
    const want = new Map<number, Array<{ on: boolean; vel: number }>>();
    for (let t = 0; t < 4; t++) want.set(t, Array.from({ length: STEPS_PER_PATTERN }, () => ({ on: false, vel: 0 })));
    if (np !== undefined) {
      const cond = condenseToKit(np, [...KIT]);
      collisions += cond.collisions.length;
      for (let t = 0; t < 4; t++) {
        const row = cond.pattern.voices[KIT[t]];
        if (row === undefined) continue;
        const arr = want.get(t)!;
        row.steps.forEach((s, i) => { if (s.on) arr[i] = { on: true, vel: (s as { velocity?: number }).velocity ?? 100 }; });
      }
    }
    for (let t = 0; t < 4; t++) {
      const got = decodeDrumPattern(b, t, p);
      const exp = want.get(t)!;
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        if (got[s].active !== exp[s].on) { mismatches++; continue; }
        if (exp[s].on) { totalHits++; if (got[s].velocity !== exp[s].vel) mismatches++; }
      }
    }
    const wantLen = a[META_OFFSETS[noteBlockIndex('midi2', p)]];
    for (const t of written) if (b[META_OFFSETS[drumBlockIndex(t, p)]] !== wantLen) mismatches++;
  }
  let beyond = 0;
  for (let p = chain.end + 1; p < PATTERNS_PER_TRACK; p++) for (let t = 0; t < 4; t++) beyond += decodeDrumPattern(b, t, p).filter((c) => c.active).length;
  const idle = [0, 1, 2, 3].filter((t) => !written.includes(t));
  if (mismatches === 0 && beyond === 0) ok(`(a) internal drums EQUAL the condenser's answer for this project's own midi2 across patterns 1..${chain.end + 1} (${totalHits} hits, on/off + velocity + length on Drum${written.map((t) => t + 1).join('/')}), nothing authored beyond the chain` + (idle.length ? ` [Drum${idle.map((t) => t + 1).join('/')} empty in this song]` : ''));
  else fail(`slot ${slot}: (a) ${mismatches} condensed-layer mismatch(es), ${beyond} stray hit(s) past the chain`);

  // (e) whole-file diff, region-classified.
  const diff: number[] = [];
  for (let o = 0; o < NCS_FILE_SIZE; o++) if (a[o] !== b[o]) diff.push(o);
  const outside = diff.filter((o) => classify(o) === undefined);
  const byRegion = new Map<string, number>();
  for (const o of diff) { const w = classify(o) ?? 'OUTSIDE THE DRUM LAYER'; byRegion.set(w, (byRegion.get(w) ?? 0) + 1); }
  const summary = [...byRegion].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([w, n]) => `${w}:${n}`).join('  ');
  if (outside.length === 0) ok(`(e) ${diff.length} byte(s) changed, ALL inside the drum layer — ${summary}`);
  else fail(`slot ${slot}: (e) ${outside.length} byte(s) changed OUTSIDE the drum layer: ${outside.slice(0, 16).map((o) => `0x${o.toString(16)}(${a[o]}->${b[o]})`).join(', ')}${outside.length > 16 ? ` (+${outside.length - 16} more)` : ''}`);
  console.log(`     drum chain slots now [${b[0x2d4]},${b[0x2d5]}] (midi2 chain is [${b[0x2d0]},${b[0x2d1]}], untouched); note-track diff bytes ${noteBad}`);
  totals.push([slot, totalHits, `Drum${written.map((t) => t + 1).join('/')}`, collisions, diff.length]);
}

console.log('\n===== (f) untouched neighbours =====');
for (const slot of WITNESSES) {
  const a = pre.get(slot); const b = post.get(slot);
  if (a === undefined || b === undefined) { fail(`witness ${slot}: missing capture`); continue; }
  if (Buffer.from(a).equals(Buffer.from(b))) ok(`witness Project ${slot} byte-identical across all ${NCS_FILE_SIZE} bytes`);
  else fail(`witness ${slot} MOVED`);
}

console.log('\n| Project | Internal hits | Tracks written | Contention | Bytes changed |');
console.log('|---|---:|---|---:|---:|');
for (const [s, h, w, c, d] of totals) console.log(`| ${s} I Believe ${s - 18}/7 | ${h} | ${w} | ${c} | ${d} |`);
console.log(`| **Total** | **${totals.reduce((n, t) => n + t[1], 0)}** | | **${totals.reduce((n, t) => n + t[3], 0)}** | |`);

console.log(`\n${failures === 0 ? 'PHASE 4 PASS — 7/7 populated, everything else byte-identical' : `${failures} FAILURES`}`);
process.exitCode = failures === 0 ? 0 : 1;
