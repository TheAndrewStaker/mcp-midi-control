/**
 * drums-up-repoint.mts — OFFLINE. Move a pack's projects onto the GENERATED pool without changing a
 * single sound: every drum binding and every per-step sample flip is renumbered from the slot it uses
 * today to the slot holding THE SAME SAMPLE FILE in the new layout.
 *
 * This is what lets Packs 3 and 4 join the generated layout at all. Their songs' drums exist only
 * internally (no MIDI 2 to rebuild from, unlike Packs 1-2), so they cannot be re-authored.
 *
 * WHAT THE CHECKS PROVE, AND WHAT THEY DO NOT. The per-hit "same sample name before and after"
 * comparison is TRUE BY CONSTRUCTION: the remap is built from the same two name tables it compares, so
 * it proves the renumbering was applied CONSISTENTLY, not that the result is right. Treat it as a
 * smoke test. The checks that carry the weight are the ones around it, each added because the
 * tautology would otherwise hide the failure:
 *   - the input must not be ALREADY MIGRATED (a second pass renumbers twice and every drum shifts to a
 *     neighbour; re-running this against a staged or post-write sweep used to pass and print "identical");
 *   - every old slot a project touches must exist in the baseline and be UNAMBIGUOUS there;
 *   - each lane's bound sample must mean the same drum FAMILY on both sides, which is the one check
 *     that can catch a wrong baseline;
 *   - the byte diff must stay inside the binding and drum_choice bytes.
 * Coverage is reported honestly: lanes with no hits, and lanes whose every hit carries a flip, are not
 * exercised by the per-hit comparison at all and rest on the family check.
 *
 * Inputs: `pools-current.json` (what each pack holds now, from live list_samples reads),
 * `pool-plan.json` (what the generator says each pack will hold), and a backup of the pack.
 * Output: staged .ncs files whose diff is confined to the 4 binding bytes and drum_choice bytes.
 *
 * Usage: npx tsx scripts/_research/drums-up-repoint.mts <pack> <backupDir> [outDir]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  NCS_FILE_SIZE, PATTERNS_PER_TRACK, STEPS_PER_PATTERN, checkNcsStructure, drumRowBase, getProjectName,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { DRUM_BINDING_OFFSET, getDrumSampleBinding, setDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { canonicalRole } from '../../packages/core/src/protocol-generic/patterns/drumRoles.js';

const RUN = 'samples/circuit-ncs/drums-up-2026-09-16';
const [packArg, backupDir, outArg] = process.argv.slice(2);
const pack = Number(packArg);
if (!pack || !backupDir) throw new Error('usage: drums-up-repoint.mts <pack> <backupDir> [outDir]');
const outDir = outArg ?? `${RUN}/staged/pack${pack}`;
/**
 * Only a run that writes the canonical staged directory may write the canonical manifest. An
 * exploratory run into a scratch directory used to overwrite it, which silently destroyed the record of
 * what was really staged, including the hashes the already-migrated guard reads.
 */
const IS_CANONICAL = resolve(outDir) === resolve(`${RUN}/staged/pack${pack}`);
const MANIFEST_PATH = IS_CANONICAL ? `${RUN}/repoint-pack${pack}.json` : join(outDir, `repoint-pack${pack}.json`);

if (resolve(backupDir) === resolve(outDir)) {
  throw new Error('backupDir and outDir are the same: that would re-read files this script already migrated and renumber them twice.');
}
/**
 * NEVER repoint the staged tree. The input has to be a BACKUP of the card as it is today; a staged file
 * has already been renumbered, and renumbering it again shifts every drum to a neighbouring slot while
 * the per-hit comparison, which is true by construction, still reports "identical". Two independent
 * checks, because this is the failure that looks most like success: the path, and the file's own hash
 * against what a previous run wrote.
 */
if (resolve(backupDir).startsWith(resolve(`${RUN}/staged`))) {
  throw new Error(`${backupDir} is inside the staged tree. Repoint from a backup of the card (pre/ or gate/), never from output this script produced.`);
}
const priorStaged = new Set<string>();
{
  const prior = `${RUN}/repoint-pack${pack}.json`;
  if (existsSync(prior)) {
    const j = JSON.parse(readFileSync(prior, 'utf8')) as { projects: { sha_staged?: string }[] };
    for (const r of j.projects) if (r.sha_staged) priorStaged.add(r.sha_staged);
  }
}
const POOLS_PATH = process.env.DRUMS_UP_POOLS ?? `${RUN}/pools-current.json`;
const current = (JSON.parse(readFileSync(POOLS_PATH, 'utf8')) as { packs: Record<string, string[]> }).packs[String(pack)];
const plan = (JSON.parse(readFileSync(`${RUN}/pool-plan.json`, 'utf8')) as { packs: { pack: number; slots: { slot: number; name: string }[] }[] })
  .packs.find((p) => p.pack === pack);
if (!current || !plan) throw new Error(`no current pool or plan for pack ${pack}`);

/**
 * Identity of a sample across layouts: the name without its wire-slot PREFIX (that prefix is exactly
 * what a relayout changes) and without the extension. Stripping the prefix can make two DIFFERENT files
 * collide: the canonical pool carries four distinct `PCM.wav` files at slots 0/19/62/63. A colliding
 * key is therefore POISONED rather than resolved, and any project touching such a slot is refused
 * instead of renumbered to a guess.
 */
const key = (name: string) => name.replace(/^\d+_/, '').replace(/\.wav$/i, '').toLowerCase();
const ambiguous = new Set<string>();
const seenOld = new Map<string, number>();
current.forEach((name, slot) => {
  if (!name) return;
  const k = key(name);
  if (seenOld.has(k)) ambiguous.add(k);
  seenOld.set(k, slot);
});
const newSlotOf = new Map<string, number>();
for (const sp of plan.slots) {
  const k = key(sp.name);
  if (newSlotOf.has(k)) ambiguous.add(k);
  newSlotOf.set(k, sp.slot);
}
/** old slot -> new slot, for every sample that survives into the new pool and is unambiguous. */
const REMAP = new Map<number, number>();
current.forEach((name, slot) => {
  if (!name || ambiguous.has(key(name))) return;
  const to = newSlotOf.get(key(name));
  if (to !== undefined) REMAP.set(slot, to);
});
if (ambiguous.size > 0) console.log(`ambiguous names, a project touching one is refused: ${[...ambiguous].join(', ')}`);
const PLAN_SLOTS = new Set(plan.slots.map((sp) => sp.slot));

mkdirSync(outDir, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let written = 0; let unchanged = 0; const failures: string[] = [];
const unexercised = { noHits: 0, allFlipped: 0 };
const report: Record<string, unknown>[] = [];

const inputs = readdirSync(backupDir).filter((f) => f.endsWith('.ncs')).sort();
if (inputs.length === 0) {
  throw new Error(`${backupDir} holds no .ncs files: nothing to repoint. Did you pass a sweep ROOT instead of its packN folder, or a pack that has never been backed up?`);
}
for (const file of inputs) {
 try {
  const slotNum = Number(/project(\d+)-/.exec(file)![1]);
  const src = new Uint8Array(readFileSync(join(backupDir, file)));
  if (src.length !== NCS_FILE_SIZE) { failures.push(`${file}: ${src.length} bytes`); continue; }
  if (priorStaged.has(sha(src))) {
    failures.push(`${file}: this file is byte-identical to something a previous repoint run STAGED, so it has already been migrated; renumbering it again would shift every drum one slot`);
    continue;
  }
  const buf = new Uint8Array(src);
  const name = getProjectName(src);

  /** What each hit SOUNDS: the sample name under the old pool. Must be identical afterwards. */
  const soundBefore: string[] = [];
  const bindingBefore = getDrumSampleBinding(src);
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      decodeDrumPattern(src, t, p).forEach((c, i) => {
        if (!c.active) return;
        const slot = c.drumChoice !== 0xff ? c.drumChoice : bindingBefore[t];
        soundBefore.push(`${t}/${p}/${i}=${current[slot] ?? `EMPTY(${slot})`}`);
      });
    }
  }

  // Renumber the binding, then every flip byte, through the same map.
  const missing = new Set<string>();
  const newBinding = bindingBefore.map((s) => {
    const to = REMAP.get(s);
    if (to === undefined) { missing.add(`binding->${current[s] ?? `EMPTY(${s})`}`); return s; }
    return to;
  });
  setDrumSampleBinding(buf, newBinding);
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const rb = drumRowBase(t, p);
      for (let i = 0; i < STEPS_PER_PATTERN; i++) {
        const off = rb + 64 + i;
        const choice = src[off];
        if (choice === 0xff) continue;
        const to = REMAP.get(choice);
        if (to === undefined) { missing.add(`flip->${current[choice] ?? `EMPTY(${choice})`}`); continue; }
        buf[off] = to;
      }
    }
  }

  const newPool: string[] = [];
  for (const s of plan.slots) newPool[s.slot] = s.name;
  const bindingAfter = getDrumSampleBinding(buf);
  const soundAfter: string[] = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      decodeDrumPattern(buf, t, p).forEach((c, i) => {
        if (!c.active) return;
        const slot = c.drumChoice !== 0xff ? c.drumChoice : bindingAfter[t];
        soundAfter.push(`${t}/${p}/${i}=${newPool[slot] ?? `EMPTY(${slot})`}`);
      });
    }
  }

  // THE GATE: every hit must resolve to the same sample, compared by identity not by slot.
  const before = soundBefore.map((s) => s.replace(/=(.*)$/, (_, n: string) => `=${key(n)}`));
  const after = soundAfter.map((s) => s.replace(/=(.*)$/, (_, n: string) => `=${key(n)}`));
  if (before.length !== after.length || before.some((b, i) => b !== after[i])) {
    const firstBad = before.findIndex((b, i) => b !== after[i]);
    failures.push(`${file}: a hit changed sample (${before[firstBad]} -> ${after[firstBad] ?? 'MISSING'})`);
    continue;
  }
  if (missing.size > 0) { failures.push(`${file}: the new pool drops ${[...missing].join(', ')}`); continue; }
  if (!checkNcsStructure(buf).ok) { failures.push(`${file}: staged file fails checkNcsStructure`); continue; }
  // Diff must be confined to the binding + drum_choice bytes.
  const allowed = new Set<number>();
  for (let i = 0; i < 4; i++) allowed.add(DRUM_BINDING_OFFSET + i);
  for (let t = 0; t < 4; t++) for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (let i = 0; i < STEPS_PER_PATTERN; i++) allowed.add(drumRowBase(t, p) + 64 + i);
  const stray: number[] = [];
  let changed = 0;
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (buf[i] !== src[i]) { changed++; if (!allowed.has(i)) stray.push(i); }
  if (stray.length) { failures.push(`${file}: ${stray.length} byte(s) outside binding/flips, first 0x${stray[0].toString(16)}`); continue; }

  // ALREADY MIGRATED? Every bound slot already sits in the plan and the renumbering is a no-op. A second
  // pass would shift every drum to a neighbour while the tautological per-hit check still said "identical".
  if (bindingBefore.every((b) => PLAN_SLOTS.has(b)) && JSON.stringify(bindingBefore) === JSON.stringify(newBinding)
      && bindingBefore.some((b) => !REMAP.has(b) || REMAP.get(b) === b)) {
    failures.push(`${file}: binding ${JSON.stringify(bindingBefore)} is already the planned layout, so this input looks ALREADY MIGRATED; refusing to renumber it twice`);
    continue;
  }
  // The check that can actually catch a wrong baseline: a lane must mean the same drum FAMILY on both sides.
  const roleFault = [0, 1, 2, 3].map((t) => {
    const oldRole = canonicalRole(key(current[bindingBefore[t]] ?? ''));
    const newRole = canonicalRole(key(newPool[newBinding[t]] ?? ''));
    return oldRole === newRole ? undefined : `Drum ${t + 1} changes role, ${current[bindingBefore[t]]} (${oldRole ?? 'unknown'}) -> ${newPool[newBinding[t]]} (${newRole ?? 'unknown'})`;
  }).filter(Boolean);
  if (roleFault.length > 0) { failures.push(`${file}: ${roleFault.join('; ')}`); continue; }
  writeFileSync(join(outDir, file), buf);
  report.push({ pack, slot: slotNum, name, file, sha_pre: sha(src), sha_staged: sha(buf), changed_bytes: changed,
    binding_before: bindingBefore, binding_after: newBinding, hits: soundBefore.length });
  if (changed === 0) unchanged++; else written++;
  for (let t = 0; t < 4; t++) {
    const laneHits = Array.from({ length: PATTERNS_PER_TRACK }, (_, pp) => decodeDrumPattern(src, t, pp).filter((c) => c.active)).flat();
    if (laneHits.length === 0) unexercised.noHits++;
    else if (laneHits.every((c) => c.drumChoice !== 0xff)) unexercised.allFlipped++;
  }
  console.log(`P${pack}:${String(slotNum).padEnd(2)} ${name.padEnd(24)} ${String(changed).padStart(3)} byte(s)  bind [${bindingBefore}] -> [${newBinding}]  ${soundBefore.length} hits renumbered consistently`);
 } catch (err) {
  failures.push(`${file}: ${(err as Error).message}`);
 }
}

writeFileSync(MANIFEST_PATH, JSON.stringify({
  pack,
  pools_source: POOLS_PATH,
  pool_plan_sha: createHash('sha256').update(readFileSync(`${RUN}/pool-plan.json`)).digest('hex').slice(0, 16),
  pools_current_sha: createHash('sha256').update(readFileSync(POOLS_PATH)).digest('hex').slice(0, 16),
  remap: [...REMAP],
  projects: report,
}, null, 2));
console.log(`\npack ${pack}: ${report.length} staged (${written} renumbered, ${unchanged} already correct), ${failures.length} failed`);
console.log(`the per-hit comparison did NOT exercise ${unexercised.noHits} lane(s) with no hits and ${unexercised.allFlipped} lane(s) where every hit is flipped; those bindings rest on the family check`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exitCode = failures.length === 0 ? 0 : 1;
