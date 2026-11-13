/**
 * verify-song-author — op-golden test for the deterministic song authoring engine (Item A).
 *
 * Loads the recipe of an invented song (`scripts/fixtures/synthetic-song/recipe.json`, the
 * hand-finished recipe of Test Song A in `scripts/syntheticSong.ts`), runs `buildProjectOps`, and
 * asserts the resulting `Operation[]` reproduces the golden device calls
 * (`scripts/fixtures/synthetic-song/authored-ops.json`) at the TARGET-NEUTRAL level: an Operation
 * carries sample NAMES (not wire slots) and no Circuit tool-arg names, so the expected values are
 * built PROGRAMMATICALLY from the golden's Circuit-shaped calls, not hand-typed:
 *
 *   - Each golden author op's `voices` (single) or `arrangement.sections[].voices` (chain) is split
 *     into `drumVoices` + `bassVoice` (= the golden's `synth1` lane).
 *   - The golden `drum_binding` (wire slots, [0,20,22,13]) is mapped back to sample NAMES via
 *     the recipe pool's wireSlot→name table → [kick, tom_mid, tom_floor, songa_m42].
 *   - `external` ← `external_targets[0]`, `levels` ← `mixer_levels`, plus
 *     projectName / colour(=colour) / tempo(=bpm) / soundingPitch(=sounding_pitch) / template(=ncs_template).
 *   - The one `placeSample` is expected as (name songa_m42, wireSlot 13); the one `clearSlot` as [9,10].
 *
 * The recipe covers every shape the engine branches on: a two-pattern arrangement and a
 * single-pattern section, the condense+external layout and an explicit four-sample binding, one
 * baked sample to place, and orphan slots to clear.
 *
 * Also exercises the synthetic cases the golden cannot (it has no reuse/drop/over-long chain):
 * a `role:'reuse'` section emits no authorProject, a `role:'drop'` section emits nothing, and a
 * >2-pattern chain sets `chainBeyondConfirmed` (a flag, never a refusal).
 *
 * Pure: no hardware, no MIDI. Run:  npx tsx scripts/verify-song-author.ts
 * Prints pass/fail counts; exits non-zero on any failure.
 *
 * KNOWN GOLDEN ASYMMETRY (target-neutral, not a defect): a SINGLE-pattern golden author op carries
 * its `voices` at the top level with NO per-pattern name, so the section-local pattern name
 * ("Interlude", "Verse") is unrecoverable from the golden. For single patterns we therefore assert
 * steps/drumVoices/bassVoice but only sanity-check that the engine supplied a name; for arrangement
 * sections the golden DOES carry per-section names (IntroA, ChorusB, ...) and those are asserted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProjectOps } from '../packages/core/src/protocol-generic/patterns/songAuthor.js';
import type {
  Operation,
  PatternSpec,
  SongRecipe,
} from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures', 'synthetic-song');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function loadJson(p: string): Json {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- assertion harness -----------------------------------------------------
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(detail ? `${name}\n    ${detail}` : name);
  }
}

/** Order-insensitive deep equality; treats a missing key and an `undefined` value as the same. */
function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function checkEqual(name: string, actual: Json, expected: Json): void {
  check(
    name,
    deepEqual(actual, expected),
    deepEqual(actual, expected)
      ? undefined
      : `actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`,
  );
}

/** Split a golden Circuit `voices` object into drum voices + the optional bass (synth1) lane. */
function splitVoices(voices: Record<string, string>): {
  drumVoices: Record<string, string>;
  bassVoice?: string;
} {
  const drumVoices: Record<string, string> = {};
  let bassVoice: string | undefined;
  for (const [k, v] of Object.entries(voices)) {
    if (k === 'synth1') bassVoice = v;
    else drumVoices[k] = v;
  }
  return { drumVoices, bassVoice };
}

// ---------------------------------------------------------------------------
// GOLDEN CASE: Test Song A
// ---------------------------------------------------------------------------
const recipe = loadJson(path.join(FIX_DIR, 'recipe.json')) as SongRecipe;
const golden = loadJson(path.join(FIX_DIR, 'authored-ops.json')) as Json;

const ops = buildProjectOps(recipe);

const placeOps = ops.filter((o): o is Extract<Operation, { kind: 'placeSample' }> => o.kind === 'placeSample');
const clearOps = ops.filter((o): o is Extract<Operation, { kind: 'clearSlot' }> => o.kind === 'clearSlot');
const authorOps = ops.filter((o): o is Extract<Operation, { kind: 'authorProject' }> => o.kind === 'authorProject');

// pool wireSlot → name, used to turn the golden's wire-slot drum_binding / sample slot back into names.
const nameByWireSlot = new Map<number, string>();
for (const item of recipe.pool) nameByWireSlot.set(item.wireSlot, item.name);

// ---- op counts ----
check('total op count is 8 (1 placeSample + 1 clearSlot + 6 authorProject)', ops.length === 8,
  `got ${ops.length}`);
check('one placeSample op', placeOps.length === 1, `got ${placeOps.length}`);
check('one clearSlot op', clearOps.length === 1, `got ${clearOps.length}`);
check('six authorProject ops', authorOps.length === golden.authors.length,
  `got ${authorOps.length}, golden has ${golden.authors.length}`);

// ---- placeSample: golden device slot 14 → wireSlot 13, filename → pool name songa_m42 ----
{
  const gs = golden.samples[0].input;
  const expectedWireSlot = gs.slot - 1; // adapter's device(1-based) = wireSlot + 1
  const expectedName = nameByWireSlot.get(expectedWireSlot);
  const op = placeOps[0];
  check('placeSample present', op !== undefined);
  if (op) {
    check('placeSample.pack === 2', op.pack === 2 && op.pack === recipe.globals.pack, `got ${op.pack}`);
    check('placeSample.sample.wireSlot === 13', op.sample.wireSlot === 13 && op.sample.wireSlot === expectedWireSlot,
      `got ${op.sample.wireSlot}`);
    check('placeSample.sample.name === songa_m42', op.sample.name === 'songa_m42' && op.sample.name === expectedName,
      `got ${op.sample.name}, expected ${expectedName}`);
    check('placeSample.sample.file === golden file', op.sample.file === gs.file,
      `got ${op.sample.file}`);
    check('placeSample.overwrite === true', op.overwrite === true);
  }
}

// ---- clearSlot: golden clears[0] → [9,10], confirmDelete true ----
{
  const gc = golden.clears[0].input;
  const op = clearOps[0];
  check('clearSlot present', op !== undefined);
  if (op) {
    check('clearSlot.pack === 2', op.pack === 2 && op.pack === recipe.globals.pack, `got ${op.pack}`);
    checkEqual('clearSlot.slots === [9,10]', op.slots, gc.slots);
    checkEqual('clearSlot.slots are the recipe\'s clearSlots', op.slots, [9, 10]);
    check('clearSlot.confirmDelete === true', op.confirmDelete === true);
  }
}

// ---- authorProject per golden author, matched by slot ----
for (const gAuthor of golden.authors) {
  const input = gAuthor.input;
  const slot: number = gAuthor.ncs_slot;
  const label = `[slot ${slot} "${input.project_name}"]`;
  const op = authorOps.find((o) => o.slot === slot);
  check(`${label} authorProject op present`, op !== undefined);
  if (!op) continue;
  const proj = op.project;

  // op-level flags
  check(`${label} op.pack === 2`, op.pack === golden.pack, `got ${op.pack}`);
  check(`${label} op.overwrite === true`, op.overwrite === true);
  check(`${label} op.backupFirst === false`, op.backupFirst === false);

  // globals + identity
  check(`${label} projectName`, proj.projectName === input.project_name,
    `got ${proj.projectName}`);
  check(`${label} colour`, proj.colour === input.colour, `got ${proj.colour}`);
  check(`${label} tempo === bpm`, proj.tempo === input.bpm, `got ${proj.tempo}`);
  check(`${label} soundingPitch`, proj.soundingPitch === input.sounding_pitch,
    `got ${proj.soundingPitch}`);
  check(`${label} template === ncs_template`, proj.template === input.ncs_template,
    `got ${proj.template}`);

  // levels / external / binding
  checkEqual(`${label} levels === mixer_levels`, proj.levels, input.mixer_levels);
  const expectedExternal = Array.isArray(input.external_targets) ? input.external_targets[0] : undefined;
  checkEqual(`${label} external === external_targets[0]`, proj.external, expectedExternal);
  const expectedBinding = Array.isArray(input.drum_binding)
    ? input.drum_binding.map((ws: number) => nameByWireSlot.get(ws))
    : undefined;
  checkEqual(`${label} binding === names(drum_binding)`, proj.binding, expectedBinding);

  // patterns — arrangement (chain) carries per-section names + steps; single carries voices+steps top-level.
  const isArrangement = input.arrangement !== undefined;
  const expectedPatterns: { name?: string; steps: number; drumVoices: Json; bassVoice?: string }[] =
    isArrangement
      ? input.arrangement.sections.map((s: Json) => {
          const { drumVoices, bassVoice } = splitVoices(s.voices);
          return { name: s.name, steps: s.steps, drumVoices, bassVoice };
        })
      : [
          (() => {
            const { drumVoices, bassVoice } = splitVoices(input.voices);
            return { steps: input.steps, drumVoices, bassVoice };
          })(),
        ];

  check(`${label} pattern count`, proj.patterns.length === expectedPatterns.length,
    `got ${proj.patterns.length}, expected ${expectedPatterns.length}`);

  proj.patterns.forEach((p: PatternSpec, i: number) => {
    const ep = expectedPatterns[i];
    if (!ep) return;
    if (isArrangement) {
      check(`${label} pattern[${i}].name === ${ep.name}`, p.name === ep.name, `got ${p.name}`);
    } else {
      // Single-pattern golden ops carry no pattern name; assert only that the engine supplied one.
      check(`${label} pattern[${i}].name is engine-supplied (golden cannot express it)`,
        typeof p.name === 'string' && p.name.length > 0, `got ${JSON.stringify(p.name)}`);
    }
    check(`${label} pattern[${i}].steps === ${ep.steps}`, p.steps === ep.steps, `got ${p.steps}`);
    checkEqual(`${label} pattern[${i}].drumVoices`, p.drumVoices, ep.drumVoices);
    checkEqual(`${label} pattern[${i}].bassVoice`, p.bassVoice, ep.bassVoice);
  });

  // The recipe has no >2-pattern chain: the flag must stay off across the whole golden.
  check(`${label} chainBeyondConfirmed not set (<=2 patterns)`, !proj.chainBeyondConfirmed);
}

// ---------------------------------------------------------------------------
// SYNTHETIC CASES — reuse / drop / over-long chain (the golden exercises none)
// ---------------------------------------------------------------------------
{
  const synthetic: SongRecipe = {
    globals: { pack: 3, template: 't.ncs', tempo: 120, colour: 'Blue', soundingPitch: true },
    pool: [{ name: 'kick', wireSlot: 0, source: 'kit' }],
    sections: [
      {
        section: 'A',
        role: 'author',
        slot: 1,
        projectName: 'Song A',
        drums: {
          layout: 'condense+external',
          levels: { drum1: 100 },
          external: { device: 'spd-sx', track: 'midi2' },
        },
        patterns: [{ name: 'A', steps: 16, drumVoices: { kick: 'X...' } }],
      },
      {
        section: 'B',
        role: 'reuse',
        reuseOf: 'A',
        slot: 1,
        projectName: 'Song B',
        drums: { layout: 'condense+external', levels: {} },
        patterns: [],
      },
      {
        section: 'C',
        role: 'drop',
        slot: 2,
        projectName: 'Song C',
        drums: { layout: 'condense+external', levels: {} },
        patterns: [],
      },
    ],
  };

  const sOps = buildProjectOps(synthetic);
  const sAuthors = sOps.filter((o) => o.kind === 'authorProject') as Extract<
    Operation,
    { kind: 'authorProject' }
  >[];

  check('S3: reuse+drop → exactly one authorProject (the author section)', sAuthors.length === 1,
    `got ${sAuthors.length}`);
  check('S3: reuse section emits NO authorProject', !sAuthors.some((o) => o.project.projectName === 'Song B'));
  check('S3: drop section emits NO authorProject', !sAuthors.some((o) => o.project.projectName === 'Song C'));
  check('S3: drop section emits nothing at all (no op names it)',
    !sOps.some((o) => o.kind === 'authorProject' && o.project.projectName === 'Song C'));
  check('S3: the one authorProject is Song A at slot 1',
    sAuthors[0]?.project.projectName === 'Song A' && sAuthors[0]?.slot === 1);
  check('S3: no clearSlot op (clearSlots absent)', !sOps.some((o) => o.kind === 'clearSlot'));
  check('S3: no placeSample op (pool is kit-only)', !sOps.some((o) => o.kind === 'placeSample'));
}

{
  // chainBeyondConfirmed: >2 patterns flags (never refuses); <=2 stays off.
  const chainRecipe: SongRecipe = {
    globals: { pack: 3, template: 't.ncs', tempo: 120, colour: 'Blue', soundingPitch: true },
    pool: [],
    sections: [
      {
        section: 'Long',
        role: 'author',
        slot: 1,
        projectName: 'Long Chain',
        drums: { layout: 'condense+external', levels: {} },
        patterns: [
          { name: 'p1', steps: 32, drumVoices: {} },
          { name: 'p2', steps: 32, drumVoices: {} },
          { name: 'p3', steps: 32, drumVoices: {} },
        ],
      },
      {
        section: 'Short',
        role: 'author',
        slot: 2,
        projectName: 'Short Chain',
        drums: { layout: 'condense+external', levels: {} },
        patterns: [
          { name: 'p1', steps: 32, drumVoices: {} },
          { name: 'p2', steps: 32, drumVoices: {} },
        ],
      },
    ],
  };
  const cOps = buildProjectOps(chainRecipe).filter(
    (o): o is Extract<Operation, { kind: 'authorProject' }> => o.kind === 'authorProject',
  );
  const long = cOps.find((o) => o.slot === 1);
  const short = cOps.find((o) => o.slot === 2);
  check('S3: >2-pattern chain sets chainBeyondConfirmed=true (flag, not refusal)',
    long?.project.chainBeyondConfirmed === true);
  check('S3: engine still emits the >2-pattern authorProject (never refuses)', long !== undefined);
  check('S3: 2-pattern chain leaves chainBeyondConfirmed unset', !short?.project.chainBeyondConfirmed);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log(`\nverify-song-author: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('All song-author op-golden checks passed.');
