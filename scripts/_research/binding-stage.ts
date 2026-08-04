/**
 * binding-stage.ts — OFFLINE. Stage every campaign project on packs 2/4/5 to the
 * canonical drum binding [1,2,5,11] = kick2 / snr / hatC / ride.
 *
 * WHY: the maintainer's 2026-07-30 instruction "I want you to correct all of the
 * tracks". Bindings on the card are a mix of [1,2,5,11] (correct, the campaign's
 * seeded-kit binding), [0,1,2,3] (the template default that was never overridden)
 * and [0,2,4,8] (an older default). All three packs' pools carry kick2/snr/hatC/ride
 * at wire slots 1/2/5/11, so [1,2,5,11] resolves correctly on every one.
 *
 * SURGICAL: writes ONLY the 4 binding bytes at 0x1a278..b. In particular it does
 * NOT touch 0x26fc7, which drumBinding.ts flags as a contested "Drum 2 mirror" vs
 * chain.ts's pattern-chain enable tail — the 137-project corpus refutes the mirror
 * reading (authored projects hold 12 there regardless of Drum 2's slot), so it is
 * chain state and writing it would clobber the chain.
 *
 * Per file it asserts: size 160,780; source passes checkNcsStructure; the diff vs
 * the device scan is a NON-EMPTY SUBSET of the 4 binding offsets and nothing else;
 * the staged binding reads back [1,2,5,11]; the staged file passes checkNcsStructure.
 * It stops on the first stray byte.
 *
 * READ-ONLY w.r.t. the device. Writes staged files to staged/ only.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkNcsStructure, getProjectName, getDrumLevel, getSynthLevel, NCS_FILE_SIZE } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getDrumSampleBinding, setDrumSampleBinding, DRUM_BINDING_OFFSET } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';

const BASE = 'samples/circuit-ncs/bindings-2026-07-30';
const SCAN = join(BASE, 'scan');
const STAGED = join(BASE, 'staged');
mkdirSync(STAGED, { recursive: true });

/** The campaign's canonical kit binding: kick2 / snr / hatC / ride. */
const CANONICAL = [1, 2, 5, 11];

/**
 * Deliberately NOT ours — excluded on the maintainer's standing call recorded in
 * drum-levels-pass-2026-07-30.md. CaughtGlim predates the campaign and its
 * un-processed state is itself the signal; the pack-4 "Sugar 2/10" pair are orphan
 * duplicates of unknown provenance belonging to no current song block.
 */
const EXCLUDE = new Set(['5/14', '5/15', '5/16', '5/17', '4/01', '4/02']);

const FN_RE = /-pack(\d+)-project(\d+)-/;

interface Row {
  key: string; pack: number; slot: number; name: string; file: string;
  binding: number[]; drums: number[]; synths: number[]; steps: number[];
}

const rows: Row[] = [];
for (const f of readdirSync(SCAN).filter(n => n.endsWith('.ncs'))) {
  const m = FN_RE.exec(f);
  if (!m) continue;
  const buf = new Uint8Array(readFileSync(join(SCAN, f)));
  if (buf.length !== NCS_FILE_SIZE) { console.log(`SKIP bad size: ${f}`); continue; }
  const pack = Number(m[1]), slot = Number(m[2]);
  rows.push({
    key: `${pack}/${String(slot).padStart(2, '0')}`, pack, slot,
    name: getProjectName(buf), file: f,
    binding: getDrumSampleBinding(buf),
    drums: [0, 1, 2, 3].map(t => getDrumLevel(buf, t)),
    synths: [getSynthLevel(buf, 1), getSynthLevel(buf, 2)],
    steps: [0, 1, 2, 3].map(t => {
      let n = 0; for (let p = 0; p < 8; p++) n += decodeDrumPattern(buf, t, p).filter(s => s.active).length; return n;
    }),
  });
}
rows.sort((a, b) => a.pack - b.pack || a.slot - b.slot);

// De-duplicate: the scan dir may hold two captures of the same slot (the Breakdown
// calibration read ran before the full pack-5 sweep). Keep the LAST filename, which
// sorts later by timestamp.
const bySlot = new Map<string, Row>();
for (const r of rows) {
  const prev = bySlot.get(r.key);
  if (!prev || r.file > prev.file) bySlot.set(r.key, r);
}
const live = [...bySlot.values()].sort((a, b) => a.pack - b.pack || a.slot - b.slot);

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
console.log(`Live projects in scan: ${live.length}\n`);
console.log(pad('slot', 7), pad('name', 22), pad('binding', 14), pad('drumLvl', 16), pad('steps', 18), 'action');
console.log('-'.repeat(105));

const targets: Row[] = [];
for (const r of live) {
  const correct = r.binding.join(',') === CANONICAL.join(',');
  const excluded = EXCLUDE.has(r.key);
  const action = excluded ? 'EXCLUDED (not ours)' : correct ? 'ok' : '<== REBIND';
  if (!correct && !excluded) targets.push(r);
  console.log(
    pad(r.key, 7), pad(r.name, 22), pad('[' + r.binding.join(',') + ']', 14),
    pad(r.drums.join('/'), 16), pad(r.steps.join('/'), 18), action,
  );
}

console.log(`\n=== TARGETS: ${targets.length} projects to rebind to [${CANONICAL.join(',')}] ===`);
const withContent = targets.filter(t => t.steps.some(s => s > 0));
console.log(`  of which ${withContent.length} carry drum CONTENT (urgent), ${targets.length - withContent.length} are silent (forward-compatible fix).`);

// ---- stage, with confined-diff assertions -------------------------------------
const BINDING_OFFSETS = new Set([0, 1, 2, 3].map(t => DRUM_BINDING_OFFSET + t));
let staged = 0;
const manifest: { key: string; pack: number; slot: number; name: string; staged: string; before: number[]; changed: number[] }[] = [];

for (const r of targets) {
  const src = new Uint8Array(readFileSync(join(SCAN, r.file)));

  const srcCheck = checkNcsStructure(src);
  if (!srcCheck.ok) throw new Error(`${r.key} source failed structure check: ${srcCheck.faults.join('; ')}`);

  const out = new Uint8Array(src);
  setDrumSampleBinding(out, CANONICAL);

  // The diff must be a NON-EMPTY SUBSET of the 4 binding offsets. Any other byte
  // is a staging bug and must stop the run.
  const diff: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (out[i] !== src[i]) diff.push(i);
  if (diff.length === 0) throw new Error(`${r.key} produced an empty diff but was flagged as a target`);
  for (const off of diff) {
    if (!BINDING_OFFSETS.has(off)) {
      throw new Error(`${r.key} STRAY BYTE at 0x${off.toString(16)} (${src[off]} -> ${out[off]}); expected only 0x1a278..b`);
    }
  }

  const readback = getDrumSampleBinding(out);
  if (readback.join(',') !== CANONICAL.join(',')) {
    throw new Error(`${r.key} staged binding reads ${readback.join(',')}, expected ${CANONICAL.join(',')}`);
  }
  const outCheck = checkNcsStructure(out);
  if (!outCheck.ok) throw new Error(`${r.key} staged file failed structure check: ${outCheck.faults.join('; ')}`);

  const name = `pack${r.pack}-project${String(r.slot).padStart(2, '0')}.ncs`;
  writeFileSync(join(STAGED, name), out);
  manifest.push({ key: r.key, pack: r.pack, slot: r.slot, name: r.name, staged: name, before: r.binding, changed: diff });
  staged++;
  console.log(`staged ${r.key} "${r.name}"  [${r.binding.join(',')}] -> [${CANONICAL.join(',')}]  (${diff.length} bytes)`);
}

writeFileSync(join(BASE, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nStaged ${staged} files to ${STAGED}. Manifest: ${join(BASE, 'manifest.json')}`);
