/**
 * OFFERING populate — STAGING. OFFLINE, READ-ONLY against the device.
 *
 * Builds the payload for the condensed internal drum layer on The Offering
 * (Pack 5, Projects 57-63) and pins each project's OWN newest canonical export
 * as the `ncs_template` for its re-author.
 *
 * ## Why the template is the project itself, not `blank_slot20.ncs`
 *
 * The Offering is external-only: every drum hit lives on the midi2 note track,
 * bound for the SPD-SX at note_offset +12, and THREE of those hits are baked
 * SPD-SX fills pinned by `voice_notes` (bridgeroll 60 / buildupflurry 61 /
 * breakdownroll 62, stored as 72/73/74). There is no staged payload from the
 * 2026-07-22 build, so a from-blank re-author would have to re-derive the whole
 * midi2 leg from Songsterr and could not be PROVEN to reproduce it byte-exactly.
 *
 * Authoring the condensed layer onto the project's OWN bytes removes that risk
 * entirely: with NO `external_targets`, the source drum voices resolve to an
 * empty destination list, so `union_notes` is EMPTY and the writer never touches
 * a note track, a note chain, a scene note-table or the project scale. midi2 —
 * pins included — survives BY CONSTRUCTION, not by reconstruction.
 *
 * The write surface is then exactly: the four drum tracks' step data + length
 * bytes, the drum sample binding, the drum levels, the drum chain slots, and the
 * two synth mixer bytes (re-stamped to the 0 they already hold).
 *
 * ## The payload
 *
 * One section per midi2 PATTERN SLOT that the project's own chain plays, with
 * that slot's drum voices recovered from its stored midi2 notes by inverting the
 * SPD-SX voice_map (+12). Velocity carries; the corpus has no micro-delays. The
 * three pinned fill notes are NOT canonical drum roles and are deliberately left
 * out: they are SPD-SX audio, so the internal kit has nothing to play for them
 * (the honest incompleteness the gap table already named).
 *
 * Run: npx tsx samples/_scratch/offering-stage.ts
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const ROOT = 'C:/dev/mcp-midi-tools';
const CANON_DIRS = [
  `${ROOT}/samples/circuit-ncs/bindings-2026-07-30/verify`,
  `${ROOT}/samples/circuit-ncs/populate-preauthor-2026-07-30`,
  `${ROOT}/samples/circuit-ncs/populate-authored-2026-07-30`,
];
const TEMPLATE_DIR = `${ROOT}/samples/circuit-ncs/offering-templates-2026-07-31`;
const SLOTS = [57, 58, 59, 60, 61, 62, 63];
/** Device-visible names, per the 2026-07-30 surgical pass. Asserted against the template. */
const EXPECT_NAME: Record<number, string> = {
  57: 'Ofr 1 Chorus', 58: 'Ofr 2 Chorus 2', 59: 'Ofr 3 Verse 2', 60: 'Ofr 4 Bridge',
  61: 'Ofr 5 Buildup', 62: 'Ofr 6 Breakdown', 63: 'Ofr 7 Outro',
};
const EXPECT_COLOUR = 'Cyan';
const EXPECT_TEMPO = 135;
const BINDING = [1, 2, 5, 11];

/** SPD-SX voice_map (GM) + the Circuit's midi2 note_offset. */
const SPDSX_GM: Record<string, number> = { kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56 };
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]));
/** The three baked SPD-SX fills. Stored note = voice_notes pin + note_offset. */
const PIN_NOTE: Record<number, string> = { 72: 'bridgeroll', 73: 'buildupflurry', 74: 'breakdownroll' };

interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface StagedProject {
  slot: number; project_name: string; colour: string; bpm: number;
  template: string; chain: [number, number]; plays: number;
  sections: StagedSection[]; order: string[];
  pins: string[]; note: string;
}

function newestCanonical(slot: number): { file: string; when: string } {
  let best: { file: string; when: string } | undefined;
  for (const dir of CANON_DIRS) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = new RegExp(`pack5-project0*${slot}-.*?-(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.ncs$`).exec(f);
      if (!m) continue;
      if (best === undefined || m[1] > best.when) best = { file: path.join(dir, f), when: m[1] };
    }
  }
  if (best === undefined) throw new Error(`no canonical capture for slot ${slot}`);
  return best;
}

mkdirSync(TEMPLATE_DIR, { recursive: true });
const staged: StagedProject[] = [];
let failures = 0;
const fail = (m: string): void => { failures++; console.log(`FAIL: ${m}`); };

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
  if (priorDrumHits !== 0) { fail(`slot ${slot}: already carries ${priorDrumHits} internal drum hit(s) — this is not an empty populate target`); continue; }
  // Scene state: the card holds NO scene chain on any of the seven (proved by
  // offering-restore-proof.ts — the 2026-07-23 conversion was restored away).
  const sceneEnd = getSceneChainEnd(buf);
  if (sceneEnd !== undefined) { fail(`slot ${slot}: a scene chain IS present (end ${sceneEnd}); this staging assumes the plain-chain state`); continue; }

  const chain = getNoteChain(buf, 'midi2');
  if (chain === undefined) { fail(`slot ${slot}: midi2 has no plain chain`); continue; }
  const plays = chain.end - chain.start + 1;
  if (chain.start !== 0) { fail(`slot ${slot}: midi2 chain starts at ${chain.start}, not 0`); continue; }

  // ── Reconstruct one section per chained midi2 pattern slot. ──
  const sections: StagedSection[] = [];
  const pins: string[] = [];
  for (let p = 0; p <= chain.end; p++) {
    const steps = decodeNotePattern(buf, 'midi2', p);
    const len = buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
    const grids = new Map<string, string[]>();
    let slots = 0; let mapped = 0; let pinned = 0;
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      for (const n of steps[s].notes) {
        slots++;
        const pin = PIN_NOTE[n.note];
        if (pin !== undefined) { pinned++; pins.push(`${pin} (note ${n.note - NOTE_OFFSET}) p${p + 1} step ${s + 1}`); continue; }
        const v = STORED_TO_VOICE.get(n.note);
        if (v === undefined) { fail(`slot ${slot} p${p} step ${s + 1}: stored note ${n.note} maps to no SPD-SX voice and is not a known pin`); continue; }
        mapped++;
        let g = grids.get(v);
        if (g === undefined) { g = Array.from({ length: STEPS_PER_PATTERN }, () => '~'); grids.set(v, g); }
        if (g[s] !== '~') fail(`slot ${slot} p${p} step ${s + 1}: voice ${v} appears twice on one step`);
        g[s] = `${v}@${n.velocity}`;
        if (n.delay !== 0) fail(`slot ${slot} p${p} step ${s + 1}: micro-delay ${n.delay} on ${v} is not carried by this reconstruction`);
      }
    }
    if (mapped + pinned !== slots) fail(`slot ${slot} p${p}: accounting ${mapped}+${pinned} != ${slots}`);
    const voices: Record<string, string> = {};
    for (const [v, g] of grids) voices[v] = g.join(' ');
    if (Object.keys(voices).length === 0) {
      // A pattern slot whose ONLY content is a baked SPD-SX fill has nothing for
      // the internal kit to play. It still needs its slot, so it goes in as an
      // all-rest kick: the condenser answers "silence", and the writer's
      // empty-fill lays a silent 32-step pattern on every drum track there.
      voices.kick = Array.from({ length: STEPS_PER_PATTERN }, () => '~').join(' ');
    }
    sections.push({ name: `p${p + 1}`, steps: len, voices });
  }

  staged.push({
    slot, project_name: name, colour, bpm,
    template: path.join(TEMPLATE_DIR, `pack5-project${slot}.ncs`).replace(/\\/g, '/'),
    chain: [chain.start, chain.end], plays,
    sections, order: sections.map((s) => s.name),
    pins,
    note: `template = ${path.basename(file)} (${when})`,
  });
  copyFileSync(file, path.join(TEMPLATE_DIR, `pack5-project${slot}.ncs`));

  const voiceSet = [...new Set(sections.flatMap((s) => Object.keys(s.voices)))];
  const hits = sections.reduce((n, s) => n + Object.values(s.voices).reduce((m, g) => m + g.split(' ').filter((t) => t !== '~').length, 0), 0);
  console.log(`slot ${slot} "${name}": ${plays} pattern slot(s), ${hits} drum hit(s), voices ${voiceSet.join('/')}${pins.length ? `, PINS kept on midi2: ${pins.join(' | ')}` : ''}`);
}

writeFileSync(`${ROOT}/samples/_scratch/offering-staged.json`, JSON.stringify(staged, null, 2));
console.log(`\nstaged ${staged.length}/7 projects -> samples/_scratch/offering-staged.json`);
console.log(`templates copied -> ${TEMPLATE_DIR}`);
console.log(failures === 0 ? 'STAGE PASS' : `${failures} FAILURES`);
process.exitCode = failures === 0 && staged.length === 7 ? 0 : 1;
