/**
 * drums-up-verify.mts — OFFLINE. The two byte-identity gates around the drums-up write pass, both
 * against samples/circuit-ncs/drums-up-2026-09-16/staged/manifest.json:
 *
 *   gate   <sweepRoot>  BEFORE writing. A fresh backup_device sweep of Packs 1-2 must be
 *                       byte-identical to the backup the staging was cut from (sha_pre). Any slot that
 *                       differs changed on the card since staging and must be RE-STAGED from the fresh
 *                       sweep (DRUMS_UP_PRE=<sweepRoot> npx tsx scripts/_research/drums-up-stage.mts),
 *                       never uploaded from the stale stage.
 *   verify <sweepRoot>  AFTER writing. A read-back sweep must be byte-identical to the staged files
 *                       (sha_staged), every one of them.
 *   pool   <stagedRoot> BEFORE writing, and it is the check the other two cannot make: they compare
 *                       BYTES, and a staged project can be byte-perfect while pointing at a pool slot
 *                       the plan no longer fills. This resolves every bound lane and every per-step flip
 *                       in every staged project against the pool AS IT WILL BE after the write (the plan
 *                       laid over whatever that pack keeps), and fails on a hit that lands on an empty
 *                       slot, or on a Drum 1 / Drum 2 that is not a kick / snare. Run it after ANY edit
 *                       to circuit-kits.json: a kit swap moves slots, and this is what says whether the
 *                       staged projects still agree with the pool they are about to meet.
 *
 * <sweepRoot> holds pack1/ .. packN/ backup_device folders. Exit code 0 = gate passed.
 *
 * Usage: npx tsx scripts/_research/drums-up-verify.mts gate|verify <sweepRoot> [packs]
 *        npx tsx scripts/_research/drums-up-verify.mts pool <stagedRoot> [packs]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';

const [mode, root, packArg] = process.argv.slice(2);
if ((mode !== 'gate' && mode !== 'verify' && mode !== 'pool') || !root) {
  throw new Error('usage: drums-up-verify.mts gate|verify <sweepRoot> [packs, e.g. 1,2,3,4]  |  drums-up-verify.mts pool <stagedRoot> [packs]');
}

interface Entry { pack: number; slot: number; name: string; sha_pre: string; sha_staged?: string; failures?: string[] }
const RUN = 'samples/circuit-ncs/drums-up-2026-09-16';
/**
 * Packs 1-2 are REBUILT (staged/manifest.json); Packs 3-4 are REPOINTED onto the generated pool
 * (repoint-pack<N>.json). Both carry sha_pre + sha_staged per project, so both gate the same way.
 */
const projects: Entry[] = [];
{
  const staged = `${RUN}/staged/manifest.json`;
  if (existsSync(staged)) projects.push(...(JSON.parse(readFileSync(staged, 'utf8')) as { projects: Entry[] }).projects);
  for (const pack of [3, 4, 5]) {
    const f = `${RUN}/repoint-pack${pack}.json`;
    if (existsSync(f)) projects.push(...(JSON.parse(readFileSync(f, 'utf8')) as { projects: Entry[] }).projects);
  }
}
const PACKS = (packArg ?? '').split(',').map(Number).filter(Boolean);
const manifest = { projects: PACKS.length ? projects.filter((p) => PACKS.includes(p.pack)) : projects };

let bad = 0;
const lines: string[] = [];

/**
 * A pack in the sweep that NO manifest covers is the dangerous case, not a harmless extra: it is a pack
 * the pass may still write while nothing on disk can put it back. Narrowing with `packs` cannot hide it.
 */
{
  const covered = new Set(projects.map((p) => p.pack));
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const m = /^pack(\d+)$/.exec(d.name);
    if (!d.isDirectory() || !m) continue;
    const pack = Number(m[1]);
    const files = readdirSync(join(root, d.name)).filter((f) => f.endsWith('.ncs')).length;
    if (!covered.has(pack)) {
      lines.push(`Pack ${pack}: ${files} project(s) in the sweep and NO manifest covers it. Nothing on disk can restore this pack: back it up and stage it, or keep the pass off it.`);
      bad++;
    }
  }
}
/**
 * POOL mode. The byte gates cannot see this: the pool is a separate object from the projects, so a
 * staged file stays byte-perfect while the slot it points at changes meaning underneath it.
 */
if (mode === 'pool') {
  const plan = JSON.parse(readFileSync(`${RUN}/pool-plan.json`, 'utf8')) as {
    packs: { pack: number; slots: { slot: number; name: string; role?: string; kit?: string }[] }[];
  };
  const current = JSON.parse(readFileSync(`${RUN}/pools-current.json`, 'utf8')) as { packs: Record<string, string[]> };
  /**
   * No lane-family assertion here, deliberately. Drum 1 = kick and Drum 2 = snare is the REBUILD's
   * convention, not the card's: Pack 3 was authored by other sessions and legitimately puts a rack tom
   * on Drum 2 for a breakdown and a closed hat on Drum 2 for three intros. The invariant that a lane
   * keeps its family is already enforced where it belongs, per project against its own pre-write
   * binding, by drums-up-repoint.mts. Asserting a global convention here only manufactures failures, so
   * this mode reports what each lane resolves to and asserts only the thing it alone can see: that no
   * hit lands on a slot the pool leaves empty.
   */
  const PATTERNS = 8;
  for (const pack of PACKS.length ? PACKS : plan.packs.map((x) => x.pack)) {
    const dir = join(root, `pack${pack}`);
    if (!existsSync(dir)) { lines.push(`Pack ${pack}: no staged folder ${dir}, skipped`); continue; }
    // The pool the projects will MEET: what the pack keeps, with the plan written over it.
    const after: string[] = [...(current.packs[String(pack)] ?? [])];
    for (const sp of plan.packs.find((x) => x.pack === pack)?.slots ?? []) after[sp.slot] = sp.name;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ncs'));
    if (files.length === 0) { lines.push(`Pack ${pack}: staged folder is EMPTY`); bad++; continue; }
    let hits = 0;
    let stranded = 0;
    /** What the pack's lanes actually resolve to, reported so a wrong-looking layout is visible. */
    const layouts = new Map<string, number>();
    for (const f of files) {
      const buf = new Uint8Array(readFileSync(join(dir, f)));
      const binding = getDrumSampleBinding(buf);
      const name = getProjectName(buf);
      for (let t = 0; t < 4; t++) {
        const bound = after[binding[t]];
        if (!bound) { lines.push(`P${pack} "${name}" Drum ${t + 1}: bound to slot ${binding[t]}, which the pool leaves EMPTY`); bad++; stranded++; }
        else layouts.set(`${bound}`, (layouts.get(`${bound}`) ?? 0) + 1);
        for (let pat = 0; pat < PATTERNS; pat++) {
          decodeDrumPattern(buf, t, pat).forEach((c, i) => {
            if (!c.active) return;
            hits++;
            const slot = c.drumChoice !== 0xff ? c.drumChoice : binding[t];
            if (!after[slot]) { lines.push(`P${pack} "${name}" Drum ${t + 1} pattern ${pat + 1} step ${i + 1}: flips to slot ${slot}, which the pool leaves EMPTY`); bad++; stranded++; }
          });
        }
      }
    }
    const laneUse = [...layouts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`).join(', ');
    lines.push(`Pack ${pack}: ${files.length} staged project(s), ${hits} hit(s) resolved, ${stranded} stranded`);
    lines.push(`  lanes bind: ${laneUse}`);
  }
  console.log(lines.join('\n'));
  console.log(bad === 0 ? 'POOL PASS' : `POOL FAIL: ${bad} problem(s)`);
  process.exitCode = bad === 0 ? 0 : 1;
} else {

for (const pack of [...new Set(manifest.projects.map((p) => p.pack))].sort()) {
  const dir = join(root, `pack${pack}`);
  if (!existsSync(dir)) { lines.push(`MISSING sweep folder ${dir}`); bad++; continue; }
  const bySlot = new Map<number, string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const slot = Number(/project(\d+)-/.exec(f)?.[1]);
    // backup_device names files by time, so the newest file for a slot wins.
    const prev = bySlot.get(slot);
    if (!prev || f > prev) bySlot.set(slot, f);
  }
  const expected = manifest.projects.filter((p) => p.pack === pack);
  for (const e of expected) {
    const f = bySlot.get(e.slot);
    const want = mode === 'gate' ? e.sha_pre : e.sha_staged;
    if (!want) { lines.push(`P${pack}:${e.slot} "${e.name}": not staged (${(e.failures ?? []).join('; ')})`); bad++; continue; }
    if (!f) { lines.push(`P${pack}:${e.slot} "${e.name}": NO FILE in the sweep`); bad++; continue; }
    const got = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
    if (got !== want) { lines.push(`P${pack}:${e.slot} "${e.name}": DIFFERS (${mode === 'gate' ? 'changed on the card since staging: re-stage it' : 'read-back != staged'})`); bad++; }
  }
  for (const slot of bySlot.keys()) {
    if (!expected.some((e) => e.slot === slot)) { lines.push(`P${pack}:${slot}: in the sweep but not in the manifest (new project since staging?)`); bad++; }
  }
  lines.push(`Pack ${pack}: ${expected.length} expected, ${bySlot.size} in sweep`);
}
console.log(lines.join('\n'));
console.log(bad === 0 ? `${mode.toUpperCase()} PASS` : `${mode.toUpperCase()} FAIL: ${bad} problem(s)`);
process.exitCode = bad === 0 ? 0 : 1;
}
