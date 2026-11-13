/**
 * verify-song-author-adapter — offline proof that the Circuit adapter (Item C)
 * reproduces, byte-for-byte, the exact apply_pattern / upload_sample / delete_project
 * argument objects a song's recipe stands for.
 *
 * It reads the two committed fixtures under `scripts/fixtures/synthetic-song/`:
 * `recipe.json` (the SongRecipe of the invented Test Song A, see `scripts/syntheticSong.ts`)
 * and `authored-ops.json` (the golden device calls for it, reviewed by hand: single-pattern
 * sections as top-level `voices` + `steps`, chains as `arrangement`, the bass on `synth1`,
 * the bound section as `drum_binding` wire slots with no external mirror, the baked sample
 * uploaded to device slot = wire slot + 1). It constructs a neutral `Operation` for each thing INLINE from the recipe (a small
 * local stand-in for Item A's engine, so this test is independent of it), maps each
 * through the adapter, and DEEP-EQUALs the emitted args against the golden's matching
 * input (authors by ncs_slot; the one delete_project; the upload_sample by device slot).
 *
 * Pass/fail counts print; a mismatch prints a focused key-level diff and exits non-zero.
 * Run: `npx tsx scripts/verify-song-author-adapter.ts`
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adaptOp, type AdapterContext } from '../packages/circuit-tracks/src/authorAdapter.js';
import type {
  Operation,
  PatternSpec,
  PoolItem,
  ResolvedProject,
  SongGlobals,
} from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';

// ── Fixture shapes (loose; the frozen types cover the engine side) ──────────

interface RecipeSectionDrums {
  layout: string;
  binding?: [string, string, string, string];
  external?: { device: string; track: string };
  levels: Record<string, number>;
}
interface RecipeSection {
  section: string;
  role: string;
  slot: number;
  projectName: string;
  drums: RecipeSectionDrums;
  patterns: PatternSpec[];
}
interface Recipe {
  globals: SongGlobals;
  pool: PoolItem[];
  sections: RecipeSection[];
  clearSlots?: number[];
}
interface Golden {
  pack: number;
  authors: { ncs_slot: number; input: Record<string, unknown> }[];
  clears: { input: Record<string, unknown> }[];
  samples: { input: Record<string, unknown> }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'synthetic-song');

const recipe = JSON.parse(readFileSync(join(FIXTURES, 'recipe.json'), 'utf8')) as Recipe;
const golden = JSON.parse(readFileSync(join(FIXTURES, 'authored-ops.json'), 'utf8')) as Golden;

const ctx: AdapterContext = { pool: recipe.pool, port: 'circuit' };

// ── Local stand-in for Item A: recipe → neutral Operation ───────────────────

/** A recipe section + the shared globals → the fully-resolved neutral project payload. */
function sectionToResolvedProject(section: RecipeSection, globals: SongGlobals): ResolvedProject {
  return {
    projectName: section.projectName,
    colour: globals.colour,
    tempo: globals.tempo,
    soundingPitch: globals.soundingPitch,
    template: globals.template,
    patterns: section.patterns.map((p) => ({
      name: p.name,
      steps: p.steps,
      drumVoices: p.drumVoices,
      ...(p.bassVoice !== undefined ? { bassVoice: p.bassVoice } : {}),
    })),
    ...(section.drums.binding !== undefined ? { binding: section.drums.binding } : {}),
    ...(section.drums.external !== undefined ? { external: section.drums.external } : {}),
    levels: section.drums.levels,
  };
}

function sectionToAuthorOp(section: RecipeSection, globals: SongGlobals): Operation {
  return {
    kind: 'authorProject',
    pack: globals.pack,
    slot: section.slot,
    project: sectionToResolvedProject(section, globals),
    overwrite: true,
    backupFirst: false,
  };
}

/** A baked pool item → a placeSample op. Its DEVICE name is the WAV's basename. */
function poolItemToPlaceSampleOp(item: PoolItem, pack: number): Operation {
  if (typeof item.source === 'string') {
    throw new Error(`poolItemToPlaceSampleOp called on a non-baked pool item: ${item.name}`);
  }
  const file = item.source.bakedFrom;
  const name = basename(file).replace(/\.wav$/i, '');
  return {
    kind: 'placeSample',
    pack,
    sample: { name, wireSlot: item.wireSlot, file },
    overwrite: true,
  };
}

function clearSlotsToOp(slots: number[], pack: number): Operation {
  return { kind: 'clearSlot', pack, slots, confirmDelete: true };
}

// ── Deep-equal + focused key diff ───────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

interface Diff { path: string; expected: unknown; actual: unknown; }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf-level differences between `expected` (golden) and `actual` (adapter), by key path. */
function collectDiffs(expected: unknown, actual: unknown, path = ''): Diff[] {
  if (deepEqual(expected, actual)) return [];
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const out: Diff[] = [];
    for (const k of keys) out.push(...collectDiffs(expected[k], actual[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: Diff[] = [];
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) out.push(...collectDiffs(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }
  return [{ path, expected, actual }];
}

// ── Build the cases: every golden input, reproduced from the recipe ──────────

interface Case { label: string; tool: string; got: unknown; want: unknown | undefined; }
const cases: Case[] = [];

// Authors, driven by the golden (so every real call must be reproduced), matched
// back to a recipe section by ncs_slot.
for (const author of golden.authors) {
  const section = recipe.sections.find((s) => s.slot === author.ncs_slot && s.role === 'author');
  if (!section) {
    cases.push({ label: `author slot ${author.ncs_slot}`, tool: 'apply_pattern', got: undefined, want: author.input });
    continue;
  }
  const call = adaptOp(sectionToAuthorOp(section, recipe.globals), ctx);
  cases.push({ label: `author slot ${author.ncs_slot} "${section.projectName}"`, tool: 'apply_pattern', got: call.args, want: author.input });
}

// The delete_project.
{
  const slots = recipe.clearSlots ?? [];
  const call = adaptOp(clearSlotsToOp(slots, recipe.globals.pack), ctx);
  cases.push({ label: `delete_project slots [${slots.join(', ')}]`, tool: 'delete_project', got: call.args, want: golden.clears[0]?.input });
}

// The upload_sample(s): every baked pool item, matched to the golden by device slot.
for (const item of recipe.pool) {
  if (typeof item.source === 'string') continue;
  const call = adaptOp(poolItemToPlaceSampleOp(item, recipe.globals.pack), ctx);
  const deviceSlot = item.wireSlot + 1;
  const want = golden.samples.find((s) => s.input.slot === deviceSlot);
  cases.push({ label: `upload_sample slot ${deviceSlot} "${item.name}"`, tool: 'upload_sample', got: call.args, want: want?.input });
}

// ── Run + report ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const gaps: string[] = [];

for (const c of cases) {
  if (c.want === undefined) {
    fail++;
    gaps.push(`${c.label}: no matching golden input found (nothing to compare against).`);
    console.log(`FAIL  ${c.tool.padEnd(15)} ${c.label} — no golden match`);
    continue;
  }
  if (c.got === undefined) {
    fail++;
    gaps.push(`${c.label}: adapter produced nothing (recipe section missing / not role 'author').`);
    console.log(`FAIL  ${c.tool.padEnd(15)} ${c.label} — adapter produced nothing`);
    continue;
  }
  if (deepEqual(c.want, c.got)) {
    pass++;
    console.log(`PASS  ${c.tool.padEnd(15)} ${c.label}`);
    continue;
  }
  fail++;
  console.log(`FAIL  ${c.tool.padEnd(15)} ${c.label}`);
  const diffs = collectDiffs(c.want, c.got);
  for (const d of diffs) {
    console.log(`        ${d.path || '(root)'}`);
    console.log(`          golden : ${JSON.stringify(d.expected)}`);
    console.log(`          adapter: ${JSON.stringify(d.actual)}`);
    gaps.push(`${c.label} @ ${d.path || '(root)'}: golden ${JSON.stringify(d.expected)} vs adapter ${JSON.stringify(d.actual)}`);
  }
}

console.log('');
console.log(`song-author-adapter: ${pass} passed, ${fail} failed, ${cases.length} total`);

if (fail > 0) {
  console.log('');
  console.log('Golden args the adapter could NOT reproduce from the contract:');
  for (const g of gaps) console.log(`  - ${g}`);
  process.exit(1);
}

console.log('All golden apply_pattern / upload_sample / delete_project inputs reproduced byte-for-byte, offline.');
