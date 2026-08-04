/**
 * OFFERING scene-chain RE-APPLICATION — OFFLINE STAGING. No device I/O.
 *
 * Re-applies the 2026-07-23 scene-chain conversion to Chorus (57), Bridge (60)
 * and Buildup (61), on top of the CURRENT card bytes (which now carry the
 * 2026-07-31 condensed internal drum layer). Two things are different from the
 * 2026-07-23 script:
 *
 *   1. It writes the per-scene DRUM tables as well as the per-scene midi2 table.
 *      In July the drum tracks were empty so a midi2-only conversion was
 *      complete; they are not empty now, and a midi2-only conversion would leave
 *      the internal drums following a stale flat range while midi2 follows the
 *      scenes. Both legs must follow the same scene structure.
 *   2. It CLEARS the stale plain-chain "active" range on every track that gets a
 *      scene table — midi2 (offset 721 = 0x2d1, the 2026-07-23 one-byte fix) AND
 *      all four drum slots. That is the bug that made Chorus scenes 1 and 2 sound
 *      like duplicates; the product's own arrangement writer does the same clear
 *      (writer.ts `clearNoteChain` / `clearDrumChains` in scene mode).
 *
 * Why the codec and not the shipped `scene_plan` tool path: `scene_plan` writes
 * per-scene tables only for the tracks IT AUTHORS. The populate authored drums
 * only (no `external_targets`, so `union_notes` is empty by construction, which
 * is exactly what preserved midi2 and its three SPD-SX pins). Running it again
 * with `scene_plan` would scene-chain the drums and leave midi2 on a stale plain
 * chain — the same drift, inverted. Authoring midi2 too would mean re-encoding
 * an ear-confirmed, hand-worked note track that cannot be proven byte-exact. So:
 * codec primitives, staged offline, with the diff asserted byte-for-byte.
 *
 * All four drum tracks get identical scene tables even where only one carries
 * content. `sceneChain.ts` notes the drum1..4 ORDER within the scene block is
 * inferred (no capture moves one drum alone); writing all four identically makes
 * that inference immaterial, exactly as `setDrumChain` does for the plain table.
 *
 * Run: npx tsx samples/_scratch/offering-scene-stage.ts
 * Output: samples/_scratch/offering-scene-staged/pack5-projectNN.ncs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, PATTERNS_PER_TRACK, STEPS_PER_PATTERN, META_OFFSETS,
  noteBlockIndex, drumBlockIndex, getProjectName, getProjectColour, projectColourName,
  getProjectTempo, checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain, clearNoteChain, clearDrumChains } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import {
  setSceneChain, setSceneNoteChain, setSceneDrumChain,
  getSceneChainEnd, getSceneNoteChain, getSceneDrumChain,
} from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
/** The newest canonical: the 2026-07-31 post-populate download, Phase-4 verified. */
export const CANON = `${ROOT}/samples/circuit-ncs/offering-authored-2026-07-31`;
export const STAGED_DIR = `${ROOT}/samples/_scratch/offering-scene-staged`;
export const BINDING = [1, 2, 5, 11];

type Range = { start: number; end: number };
export interface ScenePlan {
  slot: number;
  label: string;
  expectName: string;
  /** Scene 1..4 -> the pattern range that scene selects (0-based, inclusive). */
  scenes: [Range, Range, Range, Range];
  /** What the card must hold for this grouping to be reproducible. */
  requires: string;
}

/**
 * The three groupings, as the song doc's design table states them. Every one is
 * checked against the card's own stored content below before anything is staged.
 */
export const PLANS: ScenePlan[] = [
  {
    slot: 57, label: 'Chorus', expectName: 'Ofr 1 Chorus',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: m16-17 pickup fill, alone
      { start: 1, end: 3 }, // Scene 2: m18-19, m20-21, m22-23
      { start: 4, end: 5 }, // Scene 3: m24-25, m26-27
      { start: 6, end: 7 }, // Scene 4: m28-29, m30-31
    ],
    requires: '8 midi2 patterns, chain [0,7], 1+3+2+2 covering every slot in order',
  },
  {
    slot: 60, label: 'Bridge', expectName: 'Ofr 4 Bridge',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: bridgeroll pin + trailing snare, alone
      { start: 1, end: 3 }, // Scene 2: m97-98, m99-100, m101-102
      { start: 4, end: 5 }, // Scene 3: m103-104, m105-106
      { start: 6, end: 7 }, // Scene 4: m107-108, m109-110
    ],
    requires: '8 midi2 patterns, chain [0,7], the bridgeroll pin (stored 72) alone in p1',
  },
  {
    slot: 61, label: 'Buildup', expectName: 'Ofr 5 Buildup',
    scenes: [
      { start: 0, end: 0 }, // Scene 1: Ostinato (pattern 0)
      { start: 0, end: 0 }, // Scene 2: Ostinato, same pattern 0
      { start: 0, end: 0 }, // Scene 3: Ostinato, same pattern 0
      { start: 2, end: 2 }, // Scene 4: M140Fill (pattern 2), fires once before the wrap
    ],
    requires: '3 midi2 patterns, chain [0,2], p1==p2 (ostinato), the buildupflurry pin (stored 73) alone in p3',
  },
];

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

/** midi2 note fingerprint of one pattern: "step:note@vel" per hit, in step order. */
function midi2Sig(buf: Uint8Array, pattern: number): string[] {
  const st = decodeNotePattern(buf, 'midi2', pattern);
  const out: string[] = [];
  for (let s = 0; s < STEPS_PER_PATTERN; s++) for (const n of st[s].notes) out.push(`${s + 1}:${n.note}@${n.velocity}`);
  return out;
}
/** Drum fingerprint of one pattern across all 4 tracks. */
function drumSig(buf: Uint8Array, pattern: number): string {
  return [0, 1, 2, 3].map((t) => decodeDrumPattern(buf, t, pattern)
    .map((c, i) => (c.active ? `${i + 1}@${c.velocity}` : '')).filter(Boolean).join(',')).join('|');
}

// ── The regions this conversion is ALLOWED to move ─────────────────────────
export const SCENE_BLOCK_BASE = 0x50;
export const SCENE_BLOCK_STRIDE = 0x28;
export function allowedRegions(): Array<{ from: number; to: number; what: string }> {
  const r: Array<{ from: number; to: number; what: string }> = [];
  for (let sc = 0; sc < 4; sc++) {
    const b = SCENE_BLOCK_BASE + sc * SCENE_BLOCK_STRIDE;
    r.push({ from: b + 0x00, to: b + 0x0f, what: `scene ${sc + 1} drum table` });
    r.push({ from: b + 0x10, to: b + 0x10, what: `scene ${sc + 1} defined flag` });
    r.push({ from: b + 0x24, to: b + 0x25, what: `scene ${sc + 1} midi2 note slot` });
  }
  r.push({ from: 0x2c1, to: 0x2c1, what: 'scene-chain END byte' });
  r.push({ from: 0x26fbc, to: 0x26fbc, what: 'scene-select state A' });
  r.push({ from: 0x26fd2, to: 0x26fd2, what: 'scene-select state B' });
  r.push({ from: 0x2d0, to: 0x2d1, what: 'midi2 plain-chain clear (offset 721 = 0x2d1)' });
  r.push({ from: 0x2d4, to: 0x2d5, what: 'drum1 plain-chain clear' });
  r.push({ from: 0x2d8, to: 0x2d9, what: 'drum2 plain-chain clear' });
  r.push({ from: 0x2dc, to: 0x2dd, what: 'drum3 plain-chain clear' });
  r.push({ from: 0x2e0, to: 0x2e1, what: 'drum4 plain-chain clear' });
  return r;
}
const REGIONS = allowedRegions();
const classify = (o: number): string | undefined => REGIONS.find((x) => o >= x.from && o <= x.to)?.what;

function main(): void {
  mkdirSync(STAGED_DIR, { recursive: true });
  const canon = load(CANON);

  for (const plan of PLANS) {
    console.log(`\n===== ${plan.label} (Project ${plan.slot}) =====`);
    const a = canon.get(plan.slot);
    if (a === undefined) { fail(`no canonical capture for slot ${plan.slot}`); continue; }
    const st = checkNcsStructure(a);
    if (!st.ok) { fail(`slot ${plan.slot} canonical structure faults: ${st.faults.join('; ')}`); continue; }

    const name = getProjectName(a);
    if (name !== plan.expectName) { fail(`slot ${plan.slot}: expected "${plan.expectName}", canonical says "${name}" — WRONG SLOT, STOP`); continue; }
    ok(`name "${name}" / ${projectColourName(getProjectColour(a))} / ${getProjectTempo(a)} BPM`);

    // ── Reproducibility: does the card's own content support this grouping? ──
    const chain = getNoteChain(a, 'midi2');
    if (chain === undefined) { fail(`slot ${plan.slot}: midi2 is unchained; the grouping assumes a plain chain to convert`); continue; }
    const used = [...new Set(plan.scenes.flatMap((s) => { const xs: number[] = []; for (let i = s.start; i <= s.end; i++) xs.push(i); return xs; }))].sort((x, y) => x - y);
    const maxUsed = Math.max(...used);
    if (maxUsed > chain.end) { fail(`slot ${plan.slot}: grouping references pattern ${maxUsed + 1}, past the stored chain end ${chain.end + 1} — NOT REPRODUCIBLE, STOP`); continue; }
    // Every referenced pattern must actually hold content.
    let contentBad = false;
    for (const p of used) {
      const m = midi2Sig(a, p);
      if (m.length === 0) { fail(`slot ${plan.slot}: grouping references p${p + 1}, which holds NO midi2 content — NOT REPRODUCIBLE, STOP`); contentBad = true; }
    }
    if (contentBad) continue;
    ok(`stored midi2 chain [${chain.start},${chain.end}] covers every referenced pattern; grouping is ${plan.scenes.map((s) => s.end - s.start + 1).join('+')} over patterns {${used.map((p) => p + 1).join(',')}}`);
    console.log(`     requires: ${plan.requires}`);

    // Slot-specific structural claims the design rests on.
    if (plan.slot === 61) {
      const p1 = JSON.stringify(midi2Sig(a, 0)); const p2 = JSON.stringify(midi2Sig(a, 1));
      if (p1 === p2) ok('p1 and p2 are IDENTICAL on midi2, so three scenes pointing at p1 reproduce the ostinato exactly (p2 falls out of the arrangement, Deviation 8)');
      else fail('slot 61: p1 and p2 are NOT identical — the "same pattern three times" design is not reproducible from what is stored, STOP');
      const p3 = midi2Sig(a, 2);
      if (p3.length === 1 && /:73@/.test(p3[0])) ok(`p3 is the M140Fill trigger alone (${p3[0]} = buildupflurry, voice_notes 61)`);
      else fail(`slot 61: p3 holds ${JSON.stringify(p3)}, expected the single buildupflurry pin (stored note 73), STOP`);
    }
    if (plan.slot === 60) {
      const p1 = midi2Sig(a, 0);
      if (p1.some((x) => /:72@/.test(x))) ok(`p1 carries the bridgeroll pin (${p1.filter((x) => /:72@/.test(x)).join(',')} = voice_notes 60) and is isolated in Scene 1`);
      else fail('slot 60: p1 does NOT carry the bridgeroll pin (stored 72) — the fill is not where the grouping assumes, STOP');
    }
    if (plan.slot === 57) {
      // The Chorus fill is grid content, not a pin; assert only that the design's
      // 1+3+2+2 exhausts the stored chain in order with no gap and no overlap.
      const flat = plan.scenes.flatMap((s) => { const xs: number[] = []; for (let i = s.start; i <= s.end; i++) xs.push(i); return xs; });
      const expect = Array.from({ length: chain.end + 1 }, (_, i) => i);
      if (JSON.stringify(flat) === JSON.stringify(expect)) ok(`1+3+2+2 plays patterns 1..${chain.end + 1} exactly once each, in stored order (p1 = the m16-17 pickup fill, alone in Scene 1)`);
      else fail(`slot 57: grouping ${JSON.stringify(flat)} does not exhaust the stored chain ${JSON.stringify(expect)}, STOP`);
    }

    if (failures > 0) { console.log('  (a check above failed for this project; not staging it)'); continue; }

    // ── Stage ────────────────────────────────────────────────────────────────
    const b = new Uint8Array(a); // copy; `a` stays the pre-write oracle
    for (let sc = 0; sc < 4; sc++) {
      setSceneNoteChain(b, sc, 'midi2', plan.scenes[sc]);
      for (let t = 0; t < 4; t++) setSceneDrumChain(b, sc, t, plan.scenes[sc]);
    }
    setSceneChain(b, 4);
    clearNoteChain(b, 'midi2');
    clearDrumChains(b);

    // ── Assert the diff ──────────────────────────────────────────────────────
    const diff: number[] = [];
    for (let o = 0; o < NCS_FILE_SIZE; o++) if (a[o] !== b[o]) diff.push(o);
    const outside = diff.filter((o) => classify(o) === undefined);
    const byRegion = new Map<string, string[]>();
    for (const o of diff) {
      const w = classify(o) ?? 'OUTSIDE';
      if (!byRegion.has(w)) byRegion.set(w, []);
      byRegion.get(w)!.push(`0x${o.toString(16)}:${a[o]}->${b[o]}`);
    }
    if (outside.length === 0) ok(`${diff.length} byte(s) staged, ALL inside the scene-table + chain-tail regions`);
    else fail(`slot ${plan.slot}: ${outside.length} byte(s) OUTSIDE the allowed regions: ${outside.slice(0, 16).map((o) => `0x${o.toString(16)}(${a[o]}->${b[o]})`).join(', ')}`);
    for (const [w, xs] of byRegion) console.log(`       ${w}: ${xs.join(' ')}`);

    // Content preservation, proved on the staged buffer itself.
    let contentMoved = 0;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      if (JSON.stringify(midi2Sig(a, p)) !== JSON.stringify(midi2Sig(b, p))) contentMoved++;
      if (drumSig(a, p) !== drumSig(b, p)) contentMoved++;
      if (a[META_OFFSETS[noteBlockIndex('midi2', p)]] !== b[META_OFFSETS[noteBlockIndex('midi2', p)]]) contentMoved++;
      for (let t = 0; t < 4; t++) if (a[META_OFFSETS[drumBlockIndex(t, p)]] !== b[META_OFFSETS[drumBlockIndex(t, p)]]) contentMoved++;
    }
    if (contentMoved === 0) ok('every midi2 + drum pattern (steps, velocities, lengths) identical to the canonical');
    else fail(`slot ${plan.slot}: ${contentMoved} content fingerprint(s) moved`);

    const lv = [b[MIXER_SYNTH1_LEVEL], b[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => b[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
    if (lv.every((x) => x === 0) && JSON.stringify(getDrumSampleBinding(b)) === JSON.stringify(BINDING)) ok(`binding [${BINDING.join(',')}] and six levels 0 untouched`);
    else fail(`slot ${plan.slot}: binding/levels moved (levels ${lv.join(',')}, binding ${getDrumSampleBinding(b).join(',')})`);

    // Read the staged scene stack back through the codec's own getters.
    console.log(`     staged scene chain: Scenes 1..${getSceneChainEnd(b)}`);
    for (let sc = 0; sc < 4; sc++) {
      const n = getSceneNoteChain(b, sc, 'midi2')!;
      const ds = [0, 1, 2, 3].map((t) => getSceneDrumChain(b, sc, t)!);
      const same = ds.every((d) => d.start === n.start && d.end === n.end);
      console.log(`       scene ${sc + 1}: midi2 [${n.start},${n.end}] drums ${ds.map((d) => `[${d.start},${d.end}]`).join('')} ${same ? '(note and drum legs AGREE)' : 'MISMATCH'}`);
      if (!same) fail(`slot ${plan.slot}: scene ${sc + 1} note and drum legs disagree`);
    }
    console.log(`     plain chains cleared: midi2 [${b[0x2d0]},${b[0x2d1]}] drums [${b[0x2d4]},${b[0x2d5]}][${b[0x2d8]},${b[0x2d9]}][${b[0x2dc]},${b[0x2dd]}][${b[0x2e0]},${b[0x2e1]}]`);

    const out = path.join(STAGED_DIR, `pack5-project${plan.slot}.ncs`);
    writeFileSync(out, b);
    ok(`staged -> ${out}`);
  }

  console.log(`\n${failures === 0 ? 'STAGING PASS — 3/3 staged, diffs confined to scene-table + chain-tail' : `${failures} FAILURES — nothing may be uploaded`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
