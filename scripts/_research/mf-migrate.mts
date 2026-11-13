/**
 * mf-migrate.mts - OFFLINE. Move every project's MicroFreak part from the MIDI 1 track to SYNTH 2.
 *
 * WHY. The MicroFreak's input channel moved 3 -> 2 on 2026-09-20 (to free Ch.3 for the VE-500), so
 * every project that still addresses it on MIDI 1 / ch3 is transmitting to nothing. 76 projects
 * across four packs are in that state - effectively the whole repertoire. This is a live regression,
 * not a refinement.
 *
 * THE RULE THIS ESTABLISHES (owner, 2026-09-20): songs map to SYNTH 1 and SYNTH 2 and nothing else.
 * Synth 1 = Hydrasynth (ch1), Synth 2 = MicroFreak (ch2). Two parts, always the same two tracks. That
 * SUPERSEDES the 2026-07-30 "populate every track, level 0" decision for the note tracks: that rule
 * existed to keep a third internal voice in reserve, and the owner is deliberately trimming to two
 * now that the SPD-SX is retired. The internal engines still sit at level 0 and can be raised live -
 * which is the whole reason the patch banks matter.
 *
 * WHAT A MOVE IS, EXACTLY. The 896-byte step region is copied VERBATIM, byte for byte, rather than
 * decoded and re-encoded. A synth track and a MIDI track share one identical 28-byte step codec
 * (6 note slots + flags per step), so this is a block move, not a translation - and a verbatim copy
 * cannot silently drop a field the decoder does not model (gate ties, per-step delay, the sixth note
 * slot). The pattern LENGTH byte moves with it, because a 32-step pattern whose length byte stays 16
 * plays only its first bar - a trap this project has already been bitten by.
 *
 * WHAT IS DELIBERATELY NOT MOVED. The mixer level, pan, reverb send and sidechain of a MIDI track
 * belong to that track's AUDIO INPUT lane, not to its note data: Audio In 1 IS the MIDI 1 mixer lane.
 * The MicroFreak's audio still arrives at Input 1 and is still mixed, effected and ducked there. Only
 * the notes move. Every affected project already stores synth2 level 0, so nothing needs touching.
 *
 * Usage:
 *   npx tsx scripts/_research/mf-migrate.mts <inDir> <outDir> [--replace-synth2]
 *     inDir  = a per-pack directory of backed-up .ncs files (pack1/, pack2/, ...)
 *     --replace-synth2  required to touch a project whose synth2 already carries notes
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NCS_FILE_SIZE, META_OFFSETS, NOTE_STEP_REGION, PATTERNS_PER_TRACK,
  checkNcsStructure, noteBlockIndex, noteStepBase, getProjectName, getSynthLevel,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getSceneNoteChain, setSceneNoteChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

/** Chain table: 8 slots x 4 bytes at 0x2c4, note tracks first. */
const CHAIN = 0x2c4;
const SLOT = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 } as const;

interface Report {
  file: string; name: string; moved: number; displaced: number;
  chain: string; scenes?: number; skipped?: string;
}

/** Count note onsets on a track, so the move can be verified rather than assumed. */
function noteCount(buf: Uint8Array, track: 'synth1' | 'synth2' | 'midi1'): number {
  let n = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (const s of decodeNotePattern(buf, track, p)) if (s.active) n += s.notes.length;
  }
  return n;
}

/**
 * Move midi1 -> synth2 in place. Returns what happened, or a reason it was skipped.
 * Verifies the result by re-decoding, because a byte move that silently lands in the wrong block is
 * exactly the class of bug this whole session has been chasing.
 */
function migrate(buf: Uint8Array, allowReplace: boolean): Omit<Report, 'file' | 'name'> {
  const before = { m1: noteCount(buf, 'midi1'), s2: noteCount(buf, 'synth2') };
  if (before.m1 === 0) return { moved: 0, displaced: 0, chain: '-', scenes: 0, skipped: 'no midi1 content' };
  if (before.s2 > 0 && !allowReplace) {
    return { moved: 0, displaced: before.s2, chain: '-', scenes: 0, skipped: `synth2 already holds ${before.s2} notes (pass --replace-synth2)` };
  }

  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const from = noteStepBase('midi1', p);
    const to = noteStepBase('synth2', p);
    buf.copyWithin(to, from, from + NOTE_STEP_REGION);          // the notes, verbatim
    buf.fill(0, from, from + NOTE_STEP_REGION);                 // midi1 cleared
    const fromMeta = META_OFFSETS[noteBlockIndex('midi1', p)];
    const toMeta = META_OFFSETS[noteBlockIndex('synth2', p)];
    buf[toMeta] = buf[fromMeta];                                // pattern LENGTH follows the notes
  }

  // The chain follows too: an unchained carrier plays pattern 1 forever, which on a 16-bar part is
  // silence or a two-bar loop depending on where its notes start. Both were heard on 2026-09-20.
  const m1Start = buf[CHAIN + SLOT.midi1 * 4], m1End = buf[CHAIN + SLOT.midi1 * 4 + 1];
  buf[CHAIN + SLOT.synth2 * 4] = m1Start;
  buf[CHAIN + SLOT.synth2 * 4 + 1] = m1End;
  buf[CHAIN + SLOT.midi1 * 4] = 0;
  buf[CHAIN + SLOT.midi1 * 4 + 1] = 0;

  // SCENES CARRY THEIR OWN NOTE-TRACK TABLE. A scene-chained project stores, per scene, which
  // patterns each note track plays (block +0x18, four slots). Moving only the plain chain would leave
  // the MicroFreak part not following the scenes on the projects that use them.
  //
  // CORRECTION 2026-09-20: an earlier version of this comment said those projects "legitimately hold
  // [0,0] in the plain table, so the omission would look correct". That is WRONG and it matters.
  // `sceneChain.ts` records a hardware observation (2026-09-03, P1:56) that on load+play the
  // device follows the ACTIVE 0x2c4 table and ignores the stored scene chain, so [0,0] means pattern 1
  // forever until a scene pad is pressed. Seven projects on this card carry [0,0] on EVERY track, and
  // two of them (both copies of one Bridge project) have an empty pattern 0, so they load silent.
  // That is PRE-EXISTING - midi1 held the identical [0,0] before the move, so this migration neither
  // caused nor cured it - but it is a real defect and the comment must not imply otherwise.
  // Scenes beyond 4 are outside the device-confirmed stride and setSceneNoteChain refuses them; this
  // song set uses Scenes 1-4 only, and a refusal here is the right failure rather than a blind write.
  let scenesMoved = 0;
  for (let sc = 0; sc < 4; sc++) {
    const m1s = getSceneNoteChain(buf, sc, 'midi1');
    if (m1s === undefined) continue;                       // scene not defined
    setSceneNoteChain(buf, sc, 'synth2', m1s);
    setSceneNoteChain(buf, sc, 'midi1', { start: 0, end: 0 });
    scenesMoved++;
  }

  const after = { m1: noteCount(buf, 'midi1'), s2: noteCount(buf, 'synth2') };
  if (after.s2 !== before.m1) throw new Error(`move lost notes: midi1 had ${before.m1}, synth2 now has ${after.s2}`);
  if (after.m1 !== 0) throw new Error(`midi1 not cleared: ${after.m1} notes remain`);
  const chk = checkNcsStructure(buf);
  if (!chk.ok) throw new Error(`checkNcsStructure failed: ${JSON.stringify(chk)}`);

  return { moved: before.m1, displaced: before.s2, chain: `[${m1Start},${m1End}]`, scenes: scenesMoved };
}

const [inDir, outDir, ...flags] = process.argv.slice(2);
if (!inDir || !outDir) throw new Error('usage: mf-migrate.mts <inDir> <outDir> [--replace-synth2]');
const allowReplace = flags.includes('--replace-synth2');

const packs = readdirSync(inDir).filter((p) => p.startsWith('pack') && existsSync(join(inDir, p)));
let moved = 0, displaced = 0, skipped = 0, files = 0;
for (const pack of packs) {
  const rows: Report[] = [];
  for (const f of readdirSync(join(inDir, pack)).filter((x) => x.endsWith('.ncs')).sort()) {
    const buf = new Uint8Array(readFileSync(join(inDir, pack, f)));
    if (buf.length !== NCS_FILE_SIZE) continue;
    const name = getProjectName(buf);
    const r = migrate(buf, allowReplace);
    if (r.skipped) { if (r.displaced) { skipped++; rows.push({ file: f, name, ...r }); } continue; }
    if (getSynthLevel(buf, 2) !== 0) rows.push({ file: f, name, ...r, skipped: `NOTE: synth2 level is ${getSynthLevel(buf, 2)}, not 0` });
    mkdirSync(join(outDir, pack), { recursive: true });
    writeFileSync(join(outDir, pack, f), buf);
    files++; moved += r.moved; displaced += r.displaced;
    rows.push({ file: f, name, ...r });
  }
  if (!rows.length) continue;
  console.log(`\n=== ${pack}`);
  for (const r of rows) {
    const slot = /project0*(\d+)-/.exec(r.file)?.[1] ?? '?';
    console.log(`  slot ${slot.padStart(2)} ${r.name.padEnd(24)} moved ${String(r.moved).padStart(3)} notes  chain ${r.chain.padEnd(7)}` +
      `${r.scenes ? `  +${r.scenes} scene slots` : ''}${r.displaced ? `  displaced ${r.displaced} internal-synth notes` : ''}${r.skipped ? `  ${r.skipped}` : ''}`);
  }
}
console.log(`\n${files} project(s) migrated, ${moved} notes moved, ${displaced} internal-synth notes displaced` +
  `${skipped ? `, ${skipped} skipped (synth2 occupied, --replace-synth2 not set)` : ''}`);
console.log(`written to ${outDir}`);
