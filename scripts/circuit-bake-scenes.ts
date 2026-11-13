/**
 * circuit-bake-scenes — replicate the 4-scene block from a scene-baked REFERENCE
 * project (Project 43, a full4bar groove set, decoded 2026-06-22/23) into every other
 * `__full4bar` packed groove, so each song ships with Scene 1–4 = its four grooves
 * (tap-to-switch, each a looping 2-pattern chain).
 *
 * WHY a reference instead of writing scene bytes from the decode doc: each scene is
 * a ~39-byte block and only its per-track CHAIN bytes are documented; the rest is
 * captured-but-unsummarized. So we replicate the byte-exact region (the doc's
 * standing guidance: "replicate verbatim, do not over-derive"). The scene block
 * references chains by PATTERN INDEX (1-2/3-4/5-6/7-8) — identical across every
 * full4bar project (all pack 4 grooves into those pattern pairs) — so the absolute
 * scene bytes transplant unchanged.
 *
 * The scene delta = diff(reference, baseline) where `baseline` is the reference
 * song's OWN full4bar file with length+chain baked but NO scenes (so the diff is
 * scenes + scene-selection state only, not length/chain/groove content). We then
 * apply that exact delta to each target song's length+chain-processed file.
 *
 * Pipelines (length+chain identical to circuit-set-length-chain.ts):
 *   analyze   <reference.ncs> <refSongFull4bar.ncs>
 *   bake-all  <reference.ncs> <refSongFull4bar.ncs> <packedDir> <outDir>
 *   --selftest
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { META_OFFSETS, NCS_FILE_SIZE, drumBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const LEN32 = 0x1f;                                      // 32 steps, stored as steps-1
const CHAIN_FLAG_OFFSETS = [0x2d5, 0x2d9, 0x2dd, 0x2e1]; // one per drum track (endPattern=1)

// Offset windows where a scene delta is EXPECTED to land. Verified 2026-06-23:
// across all 10 baseline full4bar files the header window is all-zero and the two
// state windows are byte-IDENTICAL (song-independent mixer/scene-select data), so
// the reference's scene bytes transplant byte-exact into every song. Any delta
// byte OUTSIDE these windows means the reference disagrees with our processed
// baseline on groove/length/chain — a hard abort (do not transplant those).
const SCENE_WINDOWS: readonly [number, number, string][] = [
  [0x40, 0x2d0, 'scene header stack (0x51 + N×~0x27, up to 16 scenes)'],
  [0x1a200, 0x1a300, 'scene-selection state'],
  [0x26f00, 0x27000, 'scene-selection state / chain tail'],
];

/**
 * CARVED OUT of the windows above, 2026-09-20. "Byte-IDENTICAL across all 10 baselines" was true in
 * June and is not a property of the FORMAT — it was a property of ten files that had not yet been
 * given per-song kits, levels or reverb. Every field below has since been decoded and is PER PROJECT,
 * so transplanting a reference song's copy of it into every other song would overwrite exactly the
 * work that makes the songs sound different:
 *
 *   0x1a278..0x1a27b  drum -> sample slot, one per track. HARDWARE-CONFIRMED both directions
 *                     (drumBinding.ts). This is each song's KIT.
 *   0x26fbc..0x26fe7  the 4x11 per-drum record: patch_select, level, pitch, decay, distortion, eq,
 *                     pan, sends. `level` is hardware-confirmed and is set per song.
 *   0x26ff0..0x26ff2  reverb type / decay / damping, per project.
 *   0x26ff8..0x26fff  reverb send, 8 lanes, per project.
 *
 * Three of these offsets were previously read as scene state and transplanted by name
 * (0x1a27a = Drum 3's sample slot, 0x26fbc = Drum 1 patch_select, 0x26fd2 = Drum 3 patch_select) —
 * the same single-diff mis-decode corrected in chain.ts and sceneChain.ts the same day. A diff names
 * a REGION, never a field: everything the operator had selected when the capture was taken moves in
 * the same save.
 *
 * Being excluded means a reference that differs here now trips the out-of-window HARD ABORT in
 * bakeAll rather than silently carrying its own kit into ten other songs.
 */
const NOT_SCENE_STATE: readonly [number, number, string][] = [
  [0x1a278, 0x1a27c, 'drum -> sample binding (each song\'s kit)'],
  [0x26fbc, 0x26fe8, 'per-drum record: patch_select / level / pitch / decay / distortion / eq / pan / sends'],
  [0x26ff0, 0x26ff3, 'reverb type / decay / damping (per project)'],
  [0x26ff8, 0x27000, 'reverb send, 8 lanes (per project)'],
];

/** Apply the length(+chain) bake in-place — byte-identical to circuit-set-length-chain.ts. */
function processLengthChain(buf: Uint8Array, mode: 'full' | 'chop' = 'full'): Uint8Array {
  for (let track = 0; track < 4; track++) {
    for (let pattern = 0; pattern < 8; pattern++) {
      buf[META_OFFSETS[drumBlockIndex(track, pattern)]] = LEN32;
    }
  }
  if (mode === 'full') {
    for (const off of CHAIN_FLAG_OFFSETS) buf[off] = 0x01;
    // (was: buf[0x26fc7] = 0x0c — the "chain enable tail". It is Drum 2's patch_select; see
    //  NOT_SCENE_STATE above and the corrected note in packages/circuit-tracks/src/ncs/chain.ts.)
  }
  return buf;
}

function load(path: string): Uint8Array {
  const buf = new Uint8Array(readFileSync(path));
  if (buf.length !== NCS_FILE_SIZE) {
    throw new Error(`${path}: expected a ${NCS_FILE_SIZE}-byte .ncs, got ${buf.length}`);
  }
  return buf;
}

interface DeltaByte { off: number; ref: number; base: number; }

/** Bytes where `reference` differs from `baseline` (the scene delta). */
function sceneDelta(reference: Uint8Array, baseline: Uint8Array): DeltaByte[] {
  const out: DeltaByte[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) {
    if (reference[i] !== baseline[i]) out.push({ off: i, ref: reference[i], base: baseline[i] });
  }
  return out;
}

/** Apply a delta (set target[off] = ref) in-place. */
function applyDelta(target: Uint8Array, delta: readonly DeltaByte[]): void {
  for (const d of delta) target[d.off] = d.ref;
}

function classify(off: number): string | undefined {
  // Exclusions win: a decoded per-project field inside a scene window is NOT scene state.
  for (const [a, b] of NOT_SCENE_STATE) if (off >= a && off < b) return undefined;
  for (const [a, b, label] of SCENE_WINDOWS) if (off >= a && off < b) return label;
  return undefined;
}

/** Why an offset was refused, for a report that names the field instead of saying "outside". */
function refusedBecause(off: number): string | undefined {
  for (const [a, b, label] of NOT_SCENE_STATE) if (off >= a && off < b) return label;
  return undefined;
}

/** Group a sorted delta into contiguous runs for readable reporting. */
function reportDelta(delta: readonly DeltaByte[]): { outOfWindow: number } {
  let runStart = -1;
  let prev = -2;
  let outOfWindow = 0;
  const flush = (end: number): void => {
    if (runStart < 0) return;
    const run = delta.filter((d) => d.off >= runStart && d.off <= end);
    const ref = run.map((d) => d.ref.toString(16).padStart(2, '0')).join(' ');
    const base = run.map((d) => d.base.toString(16).padStart(2, '0')).join(' ');
    const where = classify(runStart)
      ?? (refusedBecause(runStart) !== undefined
        ? `!! NOT scene state: ${refusedBecause(runStart)} — per project, must not transplant !!`
        : '!! OUTSIDE expected scene windows !!');
    if (classify(runStart) === undefined) outOfWindow += run.length;
    console.log(`  @0x${runStart.toString(16)}..0x${end.toString(16)} (${run.length}B) [${where}]`);
    console.log(`     ref : ${ref}`);
    console.log(`     base: ${base}`);
  };
  for (const d of delta) {
    if (d.off !== prev + 1) { flush(prev); runStart = d.off; }
    prev = d.off;
  }
  flush(prev);
  return { outOfWindow };
}

const FULL4BAR_SUFFIX = '__full4bar.ncs';

function analyze(referencePath: string, refSongPath: string): { delta: DeltaByte[]; outOfWindow: number } {
  const reference = load(referencePath);
  const baseline = processLengthChain(load(refSongPath), 'full');
  const delta = sceneDelta(reference, baseline);
  console.log(`Scene delta: reference=${basename(referencePath)} vs baseline=${basename(refSongPath)} (length+chain processed)`);
  console.log(`  ${delta.length} differing byte(s):`);
  const { outOfWindow } = reportDelta(delta);
  if (outOfWindow > 0) {
    console.log(`\n  WARNING: ${outOfWindow} byte(s) fall OUTSIDE the expected scene windows — inspect before baking;`);
    console.log(`  they are groove/length/chain differences (the reference disagrees with our processed baseline), NOT scenes.`);
  } else {
    console.log(`\n  All delta bytes fall within the expected scene windows. Safe to transplant.`);
  }
  return { delta, outOfWindow };
}

function bakeAll(referencePath: string, refSongPath: string, packedDir: string, outDir: string): void {
  const { delta, outOfWindow } = analyze(referencePath, refSongPath);

  // Hard gate: a delta byte outside the scene windows means our length+chain
  // processed baseline does NOT match the reference's groove/length/chain — so
  // the reference is not "baseline + scenes" and the delta can't be trusted as a
  // pure scene transplant. Abort before writing anything.
  if (outOfWindow > 0) {
    throw new Error(
      `${outOfWindow} delta byte(s) fall outside the scene windows — the reference is not a clean ` +
      `"${basename(refSongPath)} + scenes". Inspect the analyze output above before baking; aborting.`,
    );
  }
  console.log(`\nGate OK: the scene delta is fully contained in the scene windows (a pure scene transplant).\n`);

  mkdirSync(outDir, { recursive: true });
  const songs = readdirSync(packedDir).filter((f) => f.endsWith(FULL4BAR_SUFFIX)).sort();
  console.log(`Baking scenes into ${songs.length} full4bar project(s):`);
  for (const f of songs) {
    const target = processLengthChain(load(join(packedDir, f)), 'full');
    applyDelta(target, delta);
    const outName = f.replace(FULL4BAR_SUFFIX, '__full4bar__scenes.ncs');
    writeFileSync(join(outDir, outName), target);
    console.log(`  ${f} → ${outName}`);
  }
  console.log(`\nWrote ${songs.length} file(s) to ${outDir}. Upload each to its slot (43,45,…,61), then confirm Scene 1–4 on-device.`);
}

/** Offline proof of the splice mechanics — no device, no reference file needed. */
function selftest(): void {
  let fail = 0;
  const ck = (label: string, ok: boolean) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) fail++; };

  const base = processLengthChain(new Uint8Array(NCS_FILE_SIZE), 'full');
  // Fabricate a "reference": base + scene bytes at the documented offsets + state.
  const reference = base.slice();
  const sceneBytes: [number, number[]][] = [
    [0x51, [0x01, 0x00, 0x00, 0x00]], [0x78, [0x02, 0x03, 0x00, 0x00]],
    [0xa0, [0x04, 0x05, 0x00, 0x00]], [0xc8, [0x06, 0x07, 0x00, 0x00]],
    // 2026-09-20: these were 0x1a27a / 0x26fbc / 0x26fd2 — Drum 3's sample slot and Drum 1 + Drum 3
    // patch_select. Moved to offsets inside the same windows that no decode has claimed, so the
    // selftest exercises the splice mechanics without asserting a mis-decode as scene state.
    [0x1a240, [0x01]], [0x26f40, [0x01]], [0x26f80, [0x01]],
  ];
  for (const [off, bytes] of sceneBytes) bytes.forEach((b, i) => { reference[off + i] = b; });

  const delta = sceneDelta(reference, base);
  // Expected = fabricated bytes that actually differ from base (a written 0x00
  // over base's 0x00 is not a diff — and that's fine: targets share base's value).
  const expected = sceneBytes.reduce((n, [off, b]) => n + b.filter((v, i) => v !== base[off + i]).length, 0);
  ck('delta finds exactly the fabricated bytes that differ from baseline', delta.length === expected);
  ck('all delta bytes classify into a scene window', delta.every((d) => classify(d.off) !== undefined));

  // Apply to base → reproduces reference.
  const rebuilt = base.slice();
  applyDelta(rebuilt, delta);
  ck('apply(delta, base) === reference', rebuilt.every((b, i) => b === reference[i]));

  // Apply to a DIFFERENT "song" (distinct groove data) → scenes land, groove untouched.
  const target = base.slice();
  const GROOVE_OFF = META_OFFSETS[drumBlockIndex(0, 0)] + 0x40; // some pattern-data byte, outside scene windows
  target[GROOVE_OFF] = 0x7a;
  ck('chosen groove byte is outside scene windows', classify(GROOVE_OFF) === undefined);

  // REGRESSION GUARD 2026-09-20. Every decoded per-project field must be REFUSED as scene state, so
  // a reference that differs there aborts the bake instead of carrying its own kit, drum levels and
  // reverb into every other song. Named offsets, not just the ranges, because the three that were
  // actually transplanted are the ones a future edit is most likely to re-add.
  for (const [off, what] of [
    [0x1a278, 'Drum 1 sample slot'], [0x1a27a, 'Drum 3 sample slot'], [0x1a27b, 'Drum 4 sample slot'],
    [0x26fbc, 'Drum 1 patch_select'], [0x26fbd, 'Drum 1 level'], [0x26fc7, 'Drum 2 patch_select'],
    [0x26fd2, 'Drum 3 patch_select'], [0x26ff0, 'reverb type'], [0x26ff8, 'reverb send lane 0'],
  ] as [number, string][]) {
    ck(`refused as scene state: 0x${off.toString(16)} (${what})`,
      classify(off) === undefined && refusedBecause(off) !== undefined);
  }
  ck('processLengthChain no longer writes the mis-decoded chain tail at 0x26fc7',
    processLengthChain(new Uint8Array(NCS_FILE_SIZE), 'full')[0x26fc7] === 0);
  const tgtBaked = target.slice();
  applyDelta(tgtBaked, delta);
  ck('target keeps its groove byte (delta did not touch pattern data)', tgtBaked[GROOVE_OFF] === 0x7a);
  ck('target gains the scene block', sceneBytes.every(([off, bytes]) => bytes.every((b, i) => tgtBaked[off + i] === b)));

  console.log(fail === 0 ? '\ncircuit-bake-scenes selftest: all checks passed' : `\ncircuit-bake-scenes selftest: ${fail} FAILED`);
  if (fail > 0) process.exit(1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--selftest') selftest();
else if (mode === 'analyze' && rest.length >= 2) analyze(rest[0], rest[1]);
else if (mode === 'bake-all' && rest.length >= 4) bakeAll(rest[0], rest[1], rest[2], rest[3]);
else {
  console.log('usage:');
  console.log('  tsx scripts/circuit-bake-scenes.ts --selftest');
  console.log('  tsx scripts/circuit-bake-scenes.ts analyze  <reference.ncs> <refSong__full4bar.ncs>');
  console.log('  tsx scripts/circuit-bake-scenes.ts bake-all <reference.ncs> <refSong__full4bar.ncs> <packedDir> <outDir>');
  process.exit(1);
}
