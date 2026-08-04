/**
 * OFFERING scene re-application — FACTS PROBE. OFFLINE, READ-ONLY.
 *
 * Verifies the three designed scene groupings against the card's own CURRENT
 * pattern content (the newest canonical, offering-authored-2026-07-31) before a
 * single byte is staged. If a grouping cannot be reproduced from what is stored,
 * this probe says so and the run stops.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, META_OFFSETS, noteBlockIndex, drumBlockIndex,
  getProjectName, getProjectColour, projectColourName, getProjectTempo,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd, getSceneNoteChain, getSceneDrumChain } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CANON = `${ROOT}/samples/circuit-ncs/offering-authored-2026-07-31`;
const TARGETS = [57, 60, 61];

function load(dir: string): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project0*(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), new Uint8Array(readFileSync(path.join(dir, f))));
  }
  return m;
}
const canon = load(CANON);

for (const slot of TARGETS) {
  const b = canon.get(slot)!;
  console.log(`\n===== Project ${slot} "${getProjectName(b)}" ${projectColourName(getProjectColour(b))} ${getProjectTempo(b)} BPM =====`);
  const ch = getNoteChain(b, 'midi2');
  console.log(`  midi2 plain chain: ${ch ? `[${ch.start},${ch.end}]` : '(unchained [0,0])'}   raw 0x2d0/0x2d1 = ${b[0x2d0]}/${b[0x2d1]}`);
  console.log(`  drum plain chain slots: d1[${b[0x2d4]},${b[0x2d5]}] d2[${b[0x2d8]},${b[0x2d9]}] d3[${b[0x2dc]},${b[0x2dd]}] d4[${b[0x2e0]},${b[0x2e1]}]  tail 0x26fc7=${b[0x26fc7]}`);
  console.log(`  scene-chain end 0x2c1 = ${b[0x2c1]} -> ${getSceneChainEnd(b) ?? '(no chain)'}   state ${b[0x26fbc]}/${b[0x26fd2]}`);
  for (let sc = 0; sc < 4; sc++) {
    const n = getSceneNoteChain(b, sc, 'midi2');
    const ds = [0,1,2,3].map((t) => getSceneDrumChain(b, sc, t));
    console.log(`    scene ${sc + 1}: defined=${b[0x50 + sc * 0x28 + 0x10] === 1} midi2=${n ? `[${n.start},${n.end}]` : '-'} drums=${ds.map((d) => d ? `[${d.start},${d.end}]` : '-').join(' ')}`);
  }
  console.log(`  binding [${getDrumSampleBinding(b).join(',')}]  levels s1=${b[MIXER_SYNTH1_LEVEL]} s2=${b[MIXER_SYNTH2_LEVEL]} d=${[0,1,2,3].map((n)=>b[DRUM_LEVEL_BASE+n*DRUM_LEVEL_STRIDE]).join('/')}`);

  // per-pattern content fingerprint on midi2 + drums
  console.log('  patterns (midi2 / drums):');
  const sigs: string[] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const st = decodeNotePattern(b, 'midi2', p);
    const notes: string[] = [];
    let hits = 0;
    for (let s = 0; s < STEPS_PER_PATTERN; s++) for (const n of st[s].notes) { hits++; notes.push(`${s + 1}:${n.note}@${n.velocity}`); }
    const dcount = [0,1,2,3].map((t) => decodeDrumPattern(b, t, p).filter((c) => c.active).length);
    const len = b[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
    const dlen = [0,1,2,3].map((t) => b[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
    const sig = JSON.stringify(notes);
    sigs.push(sig);
    const pins = notes.filter((x) => /:(7[234])@/.test(x));
    console.log(`    p${p + 1}: midi2 ${hits} hits (len ${len})  drums ${dcount.join('/')} (len ${dlen.join('/')})${pins.length ? `  PIN ${pins.join(',')}` : ''}`);
  }
  // duplicate detection among patterns within the chain
  const end = ch ? ch.end : 0;
  for (let i = 0; i <= end; i++) for (let j = i + 1; j <= end; j++) if (sigs[i] === sigs[j] && sigs[i] !== '[]') console.log(`    NOTE: p${i + 1} and p${j + 1} are IDENTICAL on midi2`);
}
