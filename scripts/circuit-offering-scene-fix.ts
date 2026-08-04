/**
 * circuit-offering-scene-fix — one-off authoring script: convert 3 of "The
 * Offering" (Sleep Token) Circuit Tracks projects (Pack 5) from a PLAIN 8-window
 * pattern chain to a 4-scene SCENE CHAIN, so a baked one-time transitional fill
 * (currently pattern 0 of the plain chain) fires once instead of refiring every
 * time the chain wraps back to pattern 0. See docs/_private/rig/songs/the-offering.md.
 *
 * Each project ALREADY holds its 8 windows correctly authored (from the current
 * plain-chain build) — this script does NOT re-author any note/drum content, it
 * only rewrites the scene-chain metadata (per-scene pattern-range tables +
 * the scene-chain END byte), via the exact decoded-beta codec primitives in
 * packages/circuit-tracks/src/ncs/sceneChain.ts. Top-level per-track chain
 * table (chain.ts, 0x2c4) is deliberately left untouched: the one hardware
 * capture that decoded scene-chain bytes (Project 64, sceneChain.ts docstring)
 * changed only 3 bytes (the scene-chain END + 2 scene-select state bytes) when
 * a working Scene 1-4 chain was built from a project that had NO prior top-
 * level chain override — so the device does not appear to consult 0x2c4 once a
 * scene chain is active. We stay inside that evidence rather than guessing a
 * "should probably clear it too" edit.
 *
 * Usage:
 *   tsx scripts/circuit-offering-scene-fix.ts <in1.ncs> <out1.ncs> <in2.ncs> <out2.ncs> <in3.ncs> <out3.ncs>
 *
 * Each pair is one project: reads <inN>, applies its scene layout (hardcoded
 * below, one per project by exported project name), writes <outN>. Prints a
 * before/after report of every scene-chain byte touched for inspection BEFORE
 * upload_project is called on the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import {
  setSceneChain, setSceneNoteChain, getSceneChainEnd, getSceneNoteChain,
} from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';

type Range = { start: number; end: number };

interface ProjectPlan {
  label: string;
  /** Expected project name (decoded from the exported file), sanity-checked before writing. */
  expectName: string;
  /** Scene 0..3 -> midi2 pattern range. */
  scenes: Range[];
}

// The 3 target projects. Ranges are 0-based, inclusive pattern indices — the
// SAME 8 (or 3, for Buildup) pattern slots each project already holds; only the
// SCENE grouping changes, not the pattern content.
const PLANS: Record<string, ProjectPlan> = {
  chorus: {
    label: 'Chorus (Project 57 / ncs_slot 56)',
    expectName: 'Offering 1/7',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: m16-17 pickup fill alone
      { start: 1, end: 3 }, // Scene 2: m18-19, m20-21, m22-23
      { start: 4, end: 5 }, // Scene 3: m24-25, m26-27
      { start: 6, end: 7 }, // Scene 4: m28-29, m30-31
    ],
  },
  bridge: {
    label: 'Bridge (Project 60 / ncs_slot 59)',
    expectName: 'Offering 4/7',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: m95-96 bridgeroll trigger + trailing snare, alone
      { start: 1, end: 3 }, // Scene 2: m97-98, m99-100, m101-102
      { start: 4, end: 5 }, // Scene 3: m103-104, m105-106
      { start: 6, end: 7 }, // Scene 4: m107-108, m109-110
    ],
  },
  buildup: {
    label: 'Buildup (Project 61 / ncs_slot 60)',
    expectName: 'Offering 5/7',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: Ostinato pass 1 (pattern 0)
      { start: 0, end: 0 }, // Scene 2: Ostinato pass 2 (same pattern 0 — no need for a 2nd copy)
      { start: 0, end: 0 }, // Scene 3: Ostinato pass 3 (same pattern 0)
      { start: 2, end: 2 }, // Scene 4: M140Fill (pattern 2), fires once right before the loop
    ],
  },
};

function decodeProjectName(buf: Uint8Array): string {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.replace(/[^\x20-\x7e]/g, '').trimEnd();
}

function load(path: string): Uint8Array {
  const buf = new Uint8Array(readFileSync(path));
  if (buf.length !== NCS_FILE_SIZE) {
    throw new Error(`${path}: expected a ${NCS_FILE_SIZE}-byte .ncs, got ${buf.length}`);
  }
  return buf;
}

function reportScenes(buf: Uint8Array, label: string): void {
  const end = getSceneChainEnd(buf);
  console.log(`  ${label}: scene-chain end = ${end === undefined ? '(none / unchained)' : end}`);
  for (let sc = 0; sc < 4; sc++) {
    const r = getSceneNoteChain(buf, sc, 'midi2');
    console.log(`    scene ${sc + 1}: midi2 = ${r ? `[${r.start},${r.end}]` : '(not defined)'}`);
  }
  const top = getNoteChain(buf, 'midi2');
  console.log(`    top-level (0x2c4) midi2 chain = ${top ? `[${top.start},${top.end}]` : '(unchained / [0,0])'}`);
}

function processProject(key: keyof typeof PLANS, inPath: string, outPath: string): void {
  const plan = PLANS[key];
  console.log(`\n=== ${plan.label} ===`);
  console.log(`  in:  ${inPath}`);
  const buf = load(inPath);
  const name = decodeProjectName(buf);
  if (name !== plan.expectName) {
    throw new Error(
      `${plan.label}: expected project name "${plan.expectName}", exported file says "${name}". ` +
      `Refusing to proceed — this may be the wrong slot/pack export.`,
    );
  }
  console.log(`  project name confirmed: "${name}"`);
  console.log('  BEFORE:');
  reportScenes(buf, 'before');

  for (let sc = 0; sc < 4; sc++) setSceneNoteChain(buf, sc, 'midi2', plan.scenes[sc]);
  setSceneChain(buf, 4);

  console.log('  AFTER:');
  reportScenes(buf, 'after');

  writeFileSync(outPath, buf);
  console.log(`  wrote: ${outPath}`);
}

const args = process.argv.slice(2);

if (args.length !== 6) {
  console.log('usage: tsx scripts/circuit-offering-scene-fix.ts <chorusIn> <chorusOut> <bridgeIn> <bridgeOut> <buildupIn> <buildupOut>');
  process.exit(1);
}
const [chorusIn, chorusOut, bridgeIn, bridgeOut, buildupIn, buildupOut] = args;
processProject('chorus', chorusIn, chorusOut);
processProject('bridge', bridgeIn, bridgeOut);
processProject('buildup', buildupIn, buildupOut);
