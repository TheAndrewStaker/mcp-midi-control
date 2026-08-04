/**
 * SURGICAL PASS 2026-07-30 — offline staging.
 *
 * Stages the three ear-confirmed Pack-5 songs from their CANONICAL bytes,
 * patching ONLY: colour (0x0c), project name (0x10..0x2f), synth mixer levels
 * (0x2701c/d -> 0/0). NO CONTENT IS RE-DERIVED, NO CONTENT IS TOUCHED.
 *
 * Asserts, per file:
 *   - every differing byte falls in {0x0c..0x0f} u {0x10..0x2f} u {0x2701c..0x2701d}
 *   - checkNcsStructure still passes
 *   - the name reads back exactly as intended
 *
 * Usage: npx tsx samples/_scratch/surgical-stage-2026-07-30.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  PROJECT_COLOUR_OFFSET, PROJECT_NAME_OFFSET, PROJECT_NAME_LEN,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  setProjectName, getProjectName, resolveProjectColour, projectColourName,
  checkNcsStructure,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const CANON = 'samples/circuit-ncs/card-backup-2026-07-29/pack5';
const OUT = 'samples/circuit-ncs/surgical-pass-verify-2026-07-30/staged';

interface Target { slot: number; name: string; colour: string; song: string }

const PLAN: Target[] = [
  // I Believe In A Thing Called Love — flat chop, no sourced section spans -> numbered.
  { song: 'I Believe', slot: 19, name: 'I Believe 1/7', colour: 'Red' },
  { song: 'I Believe', slot: 20, name: 'I Believe 2/7', colour: 'Red' },
  { song: 'I Believe', slot: 21, name: 'I Believe 3/7', colour: 'Red' },
  { song: 'I Believe', slot: 22, name: 'I Believe 4/7', colour: 'Red' },
  { song: 'I Believe', slot: 23, name: 'I Believe 5/7', colour: 'Red' },
  { song: 'I Believe', slot: 24, name: 'I Believe 6/7', colour: 'Red' },
  { song: 'I Believe', slot: 25, name: 'I Believe 7/7', colour: 'Red' },
  // Breakdown — flat 16-bar chop; its own plan says section names would LIE -> numbered.
  { song: 'Breakdown', slot: 35, name: 'Breakdown 1/5', colour: 'Pink' },
  { song: 'Breakdown', slot: 36, name: 'Breakdown 2/5', colour: 'Pink' },
  { song: 'Breakdown', slot: 37, name: 'Breakdown 3/5', colour: 'Pink' },
  { song: 'Breakdown', slot: 38, name: 'Breakdown 4/5', colour: 'Pink' },
  { song: 'Breakdown', slot: 39, name: 'Breakdown 5/5', colour: 'Pink' },
  // The Offering — roles ARE sourced (song doc "The 7 parts" + card map).
  // `Ofr` prefix, not `Offering`: names are held to <=16 chars (see NAME WIDTH below),
  // and OFR is already the maintainer's own handle for this song on the SPD-SX
  // (waves OFRBRTOM / OFRBUHAT / OFRBDSNR), so it reads as his, not as an abbreviation.
  { song: 'The Offering', slot: 57, name: 'Ofr 1 Chorus', colour: 'Cyan' },
  { song: 'The Offering', slot: 58, name: 'Ofr 2 Chorus 2', colour: 'Cyan' },
  { song: 'The Offering', slot: 59, name: 'Ofr 3 Verse 2', colour: 'Cyan' },
  { song: 'The Offering', slot: 60, name: 'Ofr 4 Bridge', colour: 'Cyan' },
  { song: 'The Offering', slot: 61, name: 'Ofr 5 Buildup', colour: 'Cyan' },
  { song: 'The Offering', slot: 62, name: 'Ofr 6 Breakdown', colour: 'Cyan' },
  { song: 'The Offering', slot: 63, name: 'Ofr 7 Outro', colour: 'Cyan' },
];

/**
 * NAME WIDTH — why every name here is <= 16 characters.
 *
 * `format.ts` documents the field as 32 bytes (0x10..0x2F) and that is what the
 * bytes do: a 20-char name writes and reads back intact. But TWO things say the
 * DEVICE-VISIBLE width may be 16:
 *   - `descriptor/reader.ts` `decodeProjectName` reads 0x10..0x1F only (16).
 *   - Census of all 99 projects in the 2026-07-29 card backup: ZERO names over
 *     16 chars, and 0x20..0x2F is all-spaces in every single one. So the card
 *     carries no example that would discriminate 16 from 32.
 * Only his eyes on the front panel can settle it. A name <= 16 is correct under
 * BOTH hypotheses; a longer one is correct under only one. Since these names
 * exist to be READ at the rig, they stay short.
 */
const NAME_CEILING = 16;

/** The ONLY byte ranges this pass is allowed to move. */
const ALLOWED: Array<[number, number]> = [
  [0x0c, 0x0f],                                   // colour word
  [PROJECT_NAME_OFFSET, PROJECT_NAME_OFFSET + PROJECT_NAME_LEN - 1], // 0x10..0x2f name
  [MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL],       // 0x2701c..0x2701d
];
const allowed = (i: number): boolean => ALLOWED.some(([a, b]) => i >= a && i <= b);

const canonPath = (slot: number): string =>
  `${CANON}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`;

mkdirSync(OUT, { recursive: true });

let fail = 0;
console.log('slot | was                  -> now                  | colour        | levels   | diff bytes (windows)');
for (const t of PLAN) {
  if (t.name.length > NAME_CEILING) {
    fail++;
    console.log(`${String(t.slot).padStart(4)} | FAIL name "${t.name}" is ${t.name.length} chars, ceiling ${NAME_CEILING}`);
    continue;
  }
  const canon = readFileSync(canonPath(t.slot));
  const out = Buffer.from(canon);

  const colourIndex = resolveProjectColour(t.colour);
  out[PROJECT_COLOUR_OFFSET] = colourIndex;
  const prevName = setProjectName(out, t.name);
  const prevLevels = `${canon[MIXER_SYNTH1_LEVEL]}/${canon[MIXER_SYNTH2_LEVEL]}`;
  out[MIXER_SYNTH1_LEVEL] = 0;
  out[MIXER_SYNTH2_LEVEL] = 0;

  // ---- assert: every diff is inside an allowed window ----
  const perWindow = new Map<string, number>();
  let stray = 0; let strayAt = -1;
  for (let i = 0; i < canon.length; i++) {
    if (canon[i] === out[i]) continue;
    if (!allowed(i)) { stray++; if (strayAt === -1) strayAt = i; continue; }
    const key = i <= 0x0f ? '0x0c' : i <= 0x2f ? 'name' : 'levels';
    perWindow.set(key, (perWindow.get(key) ?? 0) + 1);
  }
  const st = checkNcsStructure(out);
  const nameOk = getProjectName(out) === t.name;
  const colourOk = out[PROJECT_COLOUR_OFFSET] === colourIndex;
  const levelsOk = out[MIXER_SYNTH1_LEVEL] === 0 && out[MIXER_SYNTH2_LEVEL] === 0;

  const verdict = stray === 0 && st.ok && nameOk && colourOk && levelsOk;
  if (!verdict) {
    fail++;
    console.log(`${String(t.slot).padStart(4)} | FAIL stray=${stray}@0x${strayAt.toString(16)} struct=${st.ok ? 'ok' : st.faults.join(';')} name=${nameOk} colour=${colourOk} levels=${levelsOk}`);
    continue;
  }
  writeFileSync(`${OUT}/pack5-proj${String(t.slot).padStart(2, '0')}.ncs`, out);
  const windows = [...perWindow.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `${String(t.slot).padStart(4)} | ${prevName.padEnd(21)}-> ${t.name.padEnd(21)} | ` +
    `${`${colourIndex}=${projectColourName(colourIndex)}`.padEnd(13)} | ${prevLevels.padEnd(8)} | ${windows}`,
  );
}
console.log(fail === 0 ? `\nSTAGED ${PLAN.length}/${PLAN.length} to ${OUT} — every diff confined, structure ok.` : `\n${fail} FAILURE(S). Nothing may be uploaded.`);
process.exit(fail === 0 ? 0 : 1);
