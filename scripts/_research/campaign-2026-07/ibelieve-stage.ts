/**
 * I BELIEVE IN A THING CALLED LOVE — populate STAGING. OFFLINE, READ-ONLY.
 *
 * Builds the payload for the condensed internal drum layer on I Believe In A
 * Thing Called Love (Pack 5, Projects 19-25) and pins each project's OWN newest
 * canonical export as the `ncs_template` for its re-author.
 *
 * ## Why the template is the project itself — and why this song NEEDS that
 *
 * I Believe is the campaign's last unpopulated song, and it was previously
 * scoped as BLOCKED because **no doc records which bars each of the seven
 * projects covers**. That blocks a from-SOURCE re-author (you cannot re-derive
 * a part you cannot locate in the tab), but it does not block THIS: the payload
 * is recovered from the card's OWN stored midi2 content, so the bar mapping is
 * never needed. The Offering proved the method on 2026-07-31.
 *
 * With NO `external_targets`, the source drum voices resolve to an empty
 * destination list, `union_notes` comes back EMPTY, and the writer never enters
 * a note track, a note chain, a scene table or the project scale. midi1 (which
 * carries a real melodic leg on all seven, 52-96 notes) and midi2 survive BY
 * CONSTRUCTION, not by reconstruction — and the dry-run receipt proves it before
 * anything is sent, because it reports the written tracks and they are drums only.
 *
 * ## The payload
 *
 * One section per midi2 PATTERN SLOT the project's own chain plays, with that
 * slot's drum voices read back out of the stored notes by inverting the SPD-SX
 * voice_map (+12). Velocity carries; the corpus has no micro-delays.
 *
 * UNLIKE The Offering, I Believe has **no `voice_notes` pins**: every one of its
 * 1,169 stored midi2 notes maps to a canonical SPD-SX voice, asserted below. A
 * note that mapped to neither would STOP the stage rather than be dropped.
 *
 * Run: npx tsx scripts/_research/campaign-2026-07/ibelieve-stage.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
  noteBlockIndex, getProjectName, getProjectColour, projectColourName, getProjectTempo,
  checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

import { newestCanonical } from './ibelieve-facts-probe.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const TEMPLATE_DIR = `${ROOT}/samples/circuit-ncs/ibelieve-templates-2026-07-31`;
const SLOTS = [19, 20, 21, 22, 23, 24, 25];
/**
 * Device-visible names, per the 2026-07-30 surgical pass. NUMBERED, not
 * role-named: no doc records what span each project covers, so a role name
 * would be an invention. Asserted against the template; the names are NOT
 * changed by this run.
 */
const EXPECT_NAME: Record<number, string> = {
  19: 'I Believe 1/7', 20: 'I Believe 2/7', 21: 'I Believe 3/7', 22: 'I Believe 4/7',
  23: 'I Believe 5/7', 24: 'I Believe 6/7', 25: 'I Believe 7/7',
};
const EXPECT_COLOUR = 'Red';
/**
 * 128 on all seven. The tab's m109=96 mark is the TAIL only, and his standing
 * default is to end live at m108, so the stored tempo is correct and is NOT
 * touched by this run.
 */
const EXPECT_TEMPO = 128;
const BINDING = [1, 2, 5, 11];

/** SPD-SX voice_map (GM) + the Circuit's midi2 note_offset. */
const SPDSX_GM: Record<string, number> = { kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56 };
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]));

interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface StagedProject {
  slot: number; project_name: string; colour: string; bpm: number;
  template: string; chain: [number, number]; plays: number;
  sections: StagedSection[]; order: string[];
  note: string;
}

mkdirSync(TEMPLATE_DIR, { recursive: true });
const staged: StagedProject[] = [];
let failures = 0;
const fail = (m: string): void => { failures++; console.log(`FAIL: ${m}`); };

let grandSlots = 0; let grandMapped = 0;

for (const slot of SLOTS) {
  const { file, when } = newestCanonical(slot);
  const buf = new Uint8Array(readFileSync(file));
  if (buf.length !== NCS_FILE_SIZE) { fail(`slot ${slot}: ${buf.length} bytes`); continue; }
  const st = checkNcsStructure(buf);
  if (!st.ok) { fail(`slot ${slot}: structure faults ${st.faults.join('; ')}`); continue; }

  // ── Template identity asserts. A wrong file here would corrupt a project. ──
  const name = getProjectName(buf);
  if (name !== EXPECT_NAME[slot]) { fail(`slot ${slot}: template name "${name}" != "${EXPECT_NAME[slot]}"`); continue; }
  const colour = projectColourName(getProjectColour(buf));
  if (colour !== EXPECT_COLOUR) { fail(`slot ${slot}: colour ${colour} != ${EXPECT_COLOUR}`); continue; }
  const bpm = getProjectTempo(buf);
  if (bpm !== EXPECT_TEMPO) { fail(`slot ${slot}: tempo ${bpm} != ${EXPECT_TEMPO}`); continue; }
  const binding = getDrumSampleBinding(buf);
  if (JSON.stringify(binding) !== JSON.stringify(BINDING)) { fail(`slot ${slot}: binding [${binding}] != [${BINDING}]`); continue; }
  const levels = [buf[MIXER_SYNTH1_LEVEL], buf[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => buf[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
  if (levels.some((l) => l !== 0)) { fail(`slot ${slot}: levels [${levels}] are not all 0`); continue; }
  // Every drum pattern must be EMPTY: this is a populate, not a re-populate.
  let priorDrumHits = 0;
  for (let t = 0; t < 4; t++) for (let p = 0; p < PATTERNS_PER_TRACK; p++) priorDrumHits += decodeDrumPattern(buf, t, p).filter((c) => c.active).length;
  if (priorDrumHits !== 0) { fail(`slot ${slot}: already carries ${priorDrumHits} internal drum hit(s) — not an empty populate target`); continue; }
  const sceneEnd = getSceneChainEnd(buf);
  if (sceneEnd !== undefined) { fail(`slot ${slot}: a scene chain IS present (end ${sceneEnd}); this staging assumes the plain-chain state`); continue; }

  const chain = getNoteChain(buf, 'midi2');
  if (chain === undefined) { fail(`slot ${slot}: midi2 has no plain chain`); continue; }
  if (chain.start !== 0) { fail(`slot ${slot}: midi2 chain starts at ${chain.start}, not 0`); continue; }
  const plays = chain.end - chain.start + 1;

  // ── Reconstruct one section per chained midi2 pattern slot. ──
  const sections: StagedSection[] = [];
  let slotNotes = 0; let mappedNotes = 0;
  for (let p = 0; p <= chain.end; p++) {
    const steps = decodeNotePattern(buf, 'midi2', p);
    const len = buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
    const grids = new Map<string, string[]>();
    let slots = 0; let mapped = 0;
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      for (const n of steps[s].notes) {
        slots++;
        const v = STORED_TO_VOICE.get(n.note);
        // EVERY stored note must classify. I Believe carries no voice_notes
        // pins, so an unmapped note here is an unknown and STOPS the stage
        // rather than being silently dropped from the fold.
        if (v === undefined) { fail(`slot ${slot} p${p + 1} step ${s + 1}: stored note ${n.note} maps to no SPD-SX voice and this song has no known pins`); continue; }
        mapped++;
        let g = grids.get(v);
        if (g === undefined) { g = Array.from({ length: STEPS_PER_PATTERN }, () => '~'); grids.set(v, g); }
        if (g[s] !== '~') fail(`slot ${slot} p${p + 1} step ${s + 1}: voice ${v} appears twice on one step`);
        g[s] = `${v}@${n.velocity}`;
        if (n.delay !== 0) fail(`slot ${slot} p${p + 1} step ${s + 1}: micro-delay ${n.delay} on ${v} is not carried by this reconstruction`);
      }
    }
    if (mapped !== slots) fail(`slot ${slot} p${p + 1}: accounting ${mapped} != ${slots}`);
    slotNotes += slots; mappedNotes += mapped;
    const voices: Record<string, string> = {};
    for (const [v, g] of grids) voices[v] = g.join(' ');
    if (Object.keys(voices).length === 0) {
      // A midi2 pattern slot with NO drum content still needs its section, so it
      // goes in as an all-rest kick: the condenser answers "silence", and the
      // writer's empty-fill lays a silent 32-step pattern on every drum track.
      voices.kick = Array.from({ length: STEPS_PER_PATTERN }, () => '~').join(' ');
    }
    sections.push({ name: `p${p + 1}`, steps: len, voices });
  }

  grandSlots += slotNotes; grandMapped += mappedNotes;
  staged.push({
    slot, project_name: name, colour, bpm,
    template: path.join(TEMPLATE_DIR, `pack5-project${slot}.ncs`).replace(/\\/g, '/'),
    chain: [chain.start, chain.end], plays,
    sections, order: sections.map((s) => s.name),
    note: `template = ${path.basename(file)} (${when})`,
  });
  copyFileSync(file, path.join(TEMPLATE_DIR, `pack5-project${slot}.ncs`));

  const voiceSet = [...new Set(sections.flatMap((s) => Object.keys(s.voices)))];
  const hits = sections.reduce((n, s) => n + Object.values(s.voices).reduce((m, g) => m + g.split(' ').filter((t) => t !== '~').length, 0), 0);
  console.log(`slot ${slot} "${name}": ${plays} pattern slot(s), ${hits} source drum hit(s), voices ${voiceSet.join('/')}`);
}

writeFileSync(`${ROOT}/samples/_scratch/ibelieve-staged.json`, JSON.stringify(staged, null, 2));
console.log(`\nEVERY stored midi2 note accounted for: ${grandMapped}/${grandSlots} mapped to an SPD-SX voice, 0 pins, 0 unclassified`);
console.log(`staged ${staged.length}/7 projects -> samples/_scratch/ibelieve-staged.json`);
console.log(`templates copied -> ${TEMPLATE_DIR}`);
console.log(failures === 0 ? 'STAGE PASS' : `${failures} FAILURES`);
process.exitCode = failures === 0 && staged.length === 7 ? 0 : 1;
