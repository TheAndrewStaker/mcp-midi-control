/**
 * circuit-after-dark-author-rest.ts: author the REST of "After Dark" onto the
 * Circuit Tracks, projects P3..P8, completing the song.
 *
 * Build record + every decision: `docs/_private/rig/songs/after-dark.md`.
 * P1 (m1-16) and P2 (m19-34) were authored by `circuit-after-dark-author.ts`;
 * this script is its sibling and shares its discipline exactly.
 *
 * ## The chop
 *
 * The source's own section markers fall on m1, 19, 35, 51, 67, 83, 99, 115 —
 * every one exactly 16 bars after the last except the Intro (18) and the final
 * Chorus (21). A 16-bar project (8 patterns x 32 steps) therefore lands on a
 * SECTION BOUNDARY every time, with no musical compromise:
 *
 *   P3 m35-50   Chorus    P6 m83-98   Break
 *   P4 m51-66   Verse 2   P7 m99-114  Bridge
 *   P5 m67-82   Chorus    P8 m115-130 Chorus
 *
 * The only trims are at the two ends and both are LOSSLESS: m17-18 (dropped by
 * P1) and m131-135 (dropped by P8) are silent on all seven parts.
 *
 * ## Synth 2 is NOT contested
 *
 * The earlier note that "piano/pad/saw collide from m35" was an overstatement.
 * Part 5 (piano) plays m1-16 and NEVER sounds again; part 1 (the unmapped
 * piano) plays m9-16 and never again. From m19 to the end the pad is the ONLY
 * claimant on Synth 2. Measured, not assumed: see `after-dark-fullsong.ts`.
 *
 * ## MIDI 1 carries the LEAD LINE, and there is only one of them
 *
 * The maintainer's whole-song mapping puts part 3 (sawtooth) on MIDI 1, not
 * part 4 (square). `after-dark-leads.ts` measures why that is coherent and what
 * it leaves open:
 *
 *   - Parts 3 and 4 overlap in 48 measures (the three Choruses), and on all
 *     **252 of 252** shared onsets the interval is **exactly +12 semitones**
 *     with identical note lengths. Every saw onset is shared; the saw has no
 *     note of its own. It is one line in two registers, not two voices.
 *   - The saw exists ONLY in the Choruses. In Verse 1', Verse 2 and the Bridge
 *     (48 bars) the square is the only lead content there is.
 *
 * DECIDED 2026-07-27 by the maintainer, the LITERAL reading: MIDI 1 carries
 * part 3 and nothing else. It is silent through both Verses and the Bridge,
 * 48 bars with no retune target, and that is an ARTISTIC CHOICE — the VE-500
 * engages only where the sawtooth plays and he sings free everywhere else.
 * Part 4 (square) is not authored anywhere, which loses no music: it is the
 * same line as the saw an octave up on 252 of 252 shared onsets.
 *
 * ## THE OCTAVE WARNING, and it is asymmetric
 *
 * `note_offset` is an `external_targets` field, and `external_targets` resolves
 * a DRUM VOICE MAP (`entry.note + note_offset` in `externalRouting.ts`). It has
 * no bearing on a melodic pitch row. So on every project here:
 *
 *   MIDI 2 (drums)  authored +12, to land on the SPD-SX pads.
 *   MIDI 1 (saw)    authored at LITERAL source pitch, NO offset. There is no
 *                   way to give it one through external_targets.
 *
 * If the Circuit transmits MIDI-track notes an octave low (HW-SPDSX-008, still
 * open), the chorus saw leaves at d#2..f3 (39-53) and ARRIVES at d#1..f2
 * (27-41), about 39 Hz at the bottom — unsingable, and it would make choosing
 * the saw backfire. The lever if it turns out to be needed is `transpose: 12`
 * on the melodic import at authoring time, NOT note_offset and NOT a device
 * knob. Nothing is baked in on the strength of a document; he answers it by ear
 * the first time he plays a chorus.
 *
 * ## Why a standalone script and not the `apply_pattern` MCP tool
 *
 * Same reason as the P1/P2 author: the running MCP server predates the
 * `@julusian/midi` lifecycle fix and its Circuit handle is wedged. Run under
 * `npx tsx` this opens its own connection from CURRENT source. It calls
 * `executeApplyPattern` directly, the SAME function the MCP tool handler calls,
 * so the compile, condenser, external routing and overwrite gate are the
 * shipped ones.
 *
 * ## The empty check is a hard refuse-gate, in two independent layers
 *
 *  1. THIS script reads the target pack's project directory first and refuses
 *     if ANY target slot is occupied, or if the directory read fails at all.
 *     Occupancy is `name !== undefined` (the `slots` array holds all 64 and
 *     leaves `name` undefined for an empty one), cross-checked against the
 *     directory's own `occupied` count; a disagreement is unreadable, which is
 *     a refusal.
 *  2. `confirm_overwrite` is NEVER passed, so `gateProjectOverwrite` in the
 *     writer independently re-reads occupancy at write time on the same pack.
 *
 * There is no decoded delete on this device. Neither layer may be bypassed.
 *
 * ## Names
 *
 * The template carries "User Session" at 0x10 (32 bytes, space-padded ASCII),
 * which is what left P1/P2 needing a second byte-surgical rename pass over an
 * already-occupied slot. This script instead writes a PRE-NAMED copy of the
 * template per project, so the name is correct on the single authoring write
 * and no slot is ever written twice.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-author-rest.ts --payload-only  # no device at all
 *   npx tsx scripts/circuit-after-dark-author-rest.ts                 # + device survey, dry run
 *   npx tsx scripts/circuit-after-dark-author-rest.ts --apply         # author P3/P5/P6/P8
 *   npx tsx scripts/circuit-after-dark-author-rest.ts --midi1-verse square --apply   # + P4/P7
 *   npx tsx scripts/circuit-after-dark-author-rest.ts --midi1-verse none   --apply   # + P4/P7, MIDI 1 empty
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { ensureConnection } from '../packages/core/src/server-shared/connections.js';
import { endMidiScript, exitMidiScript } from './_lib/midi-lifecycle.js';
import { readProjectDirectory, readSampleDirectory } from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { downloadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import type { NoteTrack } from '../packages/circuit-tracks/src/ncs/format.js';
import { executeApplyPattern } from '../packages/core/src/protocol-generic/dispatcher/patterns.js';
import { registerDevice } from '../packages/core/src/protocol-generic/registry.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../packages/circuit-tracks/src/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '../packages/spd-sx/src/descriptor.js';
import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import { importSongsterrMelodic, importSongsterrDrums, pitchToken, type MelodicCell } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { parseVoice } from '../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { GATE_SIXTHS_PER_STEP, MAX_GATE_SIXTHS } from '../packages/core/src/protocol-generic/patterns/types.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const PAYLOAD_ONLY = argv.includes('--payload-only');
const devicePack = Number(flag('--pack') ?? '2');
const FIRST_SLOT = Number(flag('--first-slot') ?? '3');

const SONG = '501859';
const EXPECTED_REVISION = 4102120;
const BPM = 140;
const SECTION_STEPS = 32;
const MAX_GATE_STEPS = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;   // 16
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const TPL_DIR = 'samples/circuit-tracks/_afterdark-rest';
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/** The settled mapping. Asserted against the live roster before anything else. */
const ROSTER_EXPECT: Record<number, string> = {
  0: 'Synth Bass 1', 1: 'Acoustic Grand Piano', 2: 'Pad 2 (warm)',
  3: 'Lead 2 (sawtooth)', 4: 'Lead 1 (square)', 5: 'Acoustic Grand Piano', 6: 'Drums',
};

/**
 * `--midi1-verse` decides what MIDI 1 does in Verse 2 and the Bridge. It has no
 * default: MIDI 1 retunes the maintainer's voice, so it is his call and the
 * script will not guess.
 *
 *   none    HIS DECISION, 2026-07-27. MIDI 1 carries part 3 only, so it is
 *           EMPTY through both Verses and the Bridge. Intended, not an
 *           oversight: the retune engages only where the sawtooth plays.
 *   square  the rejected alternative, kept so the reasoning stays legible: the
 *           square lead (part 4) fills MIDI 1 and the retune runs continuously.
 *
 * Unset, P4 and P7 are HELD and only the four projects both readings agree on
 * are authored.
 */
type Midi1Verse = 'square' | 'none' | undefined;
const MIDI1_VERSE = flag('--midi1-verse') as Midi1Verse;
if (MIDI1_VERSE !== undefined && MIDI1_VERSE !== 'square' && MIDI1_VERSE !== 'none') {
  console.log(`REFUSED: --midi1-verse must be "square" or "none", got "${MIDI1_VERSE}".`);
  process.exit(1);
}

/**
 * One project per SECTION. `melodic` is the corrected whole-song mapping:
 * Synth 1 = part 0 bass, Synth 2 = part 2 pad, MIDI 1 = part 3 sawtooth where
 * it exists (the three Choruses), MIDI 2 = part 6 drums where they exist (the
 * Break and the Bridge are drumless in the source, so those projects carry no
 * MIDI 2 route at all).
 *
 * `held` marks the two projects whose MIDI 1 depends on the open question.
 */
const VERSE_MIDI1: [number, string][] = MIDI1_VERSE === 'square' ? [[4, 'midi1']] : [];
const SPECS = [
  { label: 'P3', name: 'AfterDark P3', section: 'Chorus',  from: 35,  to: 50,  melodic: [[0, 'synth1'], [2, 'synth2'], [3, 'midi1']] as [number, string][], drums: true,  held: false },
  { label: 'P4', name: 'AfterDark P4', section: 'Verse 2', from: 51,  to: 66,  melodic: [[0, 'synth1'], [2, 'synth2'], ...VERSE_MIDI1] as [number, string][], drums: true,  held: MIDI1_VERSE === undefined },
  { label: 'P5', name: 'AfterDark P5', section: 'Chorus',  from: 67,  to: 82,  melodic: [[0, 'synth1'], [2, 'synth2'], [3, 'midi1']] as [number, string][], drums: true,  held: false },
  { label: 'P6', name: 'AfterDark P6', section: 'Break',   from: 83,  to: 98,  melodic: [[0, 'synth1'], [2, 'synth2']]                as [number, string][], drums: false, held: false },
  { label: 'P7', name: 'AfterDark P7', section: 'Bridge',  from: 99,  to: 114, melodic: [[0, 'synth1'], [2, 'synth2'], ...VERSE_MIDI1] as [number, string][], drums: false, held: MIDI1_VERSE === undefined },
  { label: 'P8', name: 'AfterDark P8', section: 'Chorus',  from: 115, to: 130, melodic: [[0, 'synth1'], [2, 'synth2'], [3, 'midi1']] as [number, string][], drums: true,  held: false },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The Circuit flushes its pack manifest roughly 6-8 SECONDS AFTER a session
 * closes. A directory read taken sooner reports slots EMPTY that a later read
 * shows present: on 2026-07-27 a read at 1.2s reported 8 phantom-empty sample
 * slots on this very pack. On a device with no erase that is the dangerous
 * direction — a phantom empty invites a write onto occupied space, and a
 * phantom "write failed" invites a redo.
 *
 * So never trust a single fast read. Settle, then poll until two CONSECUTIVE
 * reads agree on both the occupied count and the exact name set. A directory
 * that never stabilises is unreadable, and unreadable is a refusal.
 */
const SETTLE_MS = 9_000;
const POLL_MS = 5_000;
const MAX_POLLS = 6;

const fingerprint = (d: Awaited<ReturnType<typeof readProjectDirectory>>): string =>
  `${d.occupied}|${d.slots.filter((s) => s.name !== undefined).map((s) => `${s.slot}:${s.name}`).sort().join(',')}`;

async function readDirectoryStable(
  conn: Parameters<typeof readProjectDirectory>[0], wirePack: number,
): Promise<Awaited<ReturnType<typeof readProjectDirectory>>> {
  console.log(`   settling ${SETTLE_MS / 1000}s for the pack manifest flush before the first read...`);
  await sleep(SETTLE_MS);
  let prev = await readProjectDirectory(conn, wirePack);
  let prevFp = fingerprint(prev);
  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const next = await readProjectDirectory(conn, wirePack);
    const fp = fingerprint(next);
    if (fp === prevFp) {
      console.log(`   directory stable after ${i} confirming poll(s): ${next.occupied} of ${next.total} occupied`);
      return next;
    }
    console.log(`   directory still settling (poll ${i}: ${prev.occupied} -> ${next.occupied} occupied), re-reading...`);
    prev = next; prevFp = fp;
  }
  console.log(`REFUSED: the project directory never stabilised across ${MAX_POLLS} polls. Unreadable is a refusal.`);
  return exitMidiScript(1);
}

/** Download with the same settle discipline, so a slow flush is not read as a failed write. */
async function downloadStable(
  conn: Parameters<typeof downloadProject>[0], slot: number, wirePack: number, label: string,
): Promise<Awaited<ReturnType<typeof downloadProject>>> {
  let last = await downloadProject(conn, slot - 1, { pack: wirePack, reconnect: () => connect(CONNECT) });
  for (let i = 1; i <= MAX_POLLS && (!last.ok || !last.crcOk || last.bytes === undefined); i++) {
    console.log(`   ${label}: read ${i} came back ok=${last.ok} crcOk=${last.crcOk}; waiting ${POLL_MS / 1000}s and retrying (manifest flush, NOT a failed write)`);
    await sleep(POLL_MS);
    last = await downloadProject(conn, slot - 1, { pack: wirePack, reconnect: () => connect(CONNECT) });
  }
  return last;
}

interface Emitted { token: string; gateSteps: number; tie: boolean }

function layoutSection(cells: MelodicCell[], base: number): { row: (Emitted | undefined)[]; splits: number; clamps: string[] } {
  const row: (Emitted | undefined)[] = Array.from({ length: SECTION_STEPS }, () => undefined);
  let splits = 0;
  const clamps: string[] = [];
  for (const c of cells) {
    const local = c.step - base;
    const token = c.pitches.map(pitchToken).join('+');
    if (c.duration_steps <= MAX_GATE_STEPS) { row[local] = { token, gateSteps: c.duration_steps, tie: false }; continue; }
    let remaining = c.duration_steps;
    let at = local;
    while (remaining > MAX_GATE_STEPS) {
      const next = at + MAX_GATE_STEPS;
      if (next >= SECTION_STEPS || row[next] !== undefined) break;
      row[at] = { token, gateSteps: MAX_GATE_STEPS, tie: true };
      remaining -= MAX_GATE_STEPS; at = next;
    }
    if (remaining > MAX_GATE_STEPS) {
      row[at] = { token, gateSteps: MAX_GATE_STEPS, tie: false };
      clamps.push(`local step ${local} ${token}: wanted ${c.duration_steps}, no room to chain, emitted ${MAX_GATE_STEPS}`);
    } else { row[at] = { token, gateSteps: remaining, tie: false }; splits++; }
  }
  return { row, splits, clamps };
}

const render = (row: (Emitted | undefined)[]): string =>
  row.map((e) => (e === undefined ? '~' : `${e.token}:${e.gateSteps}${e.tie ? '_' : ''}`)).join(' ');

/** Re-parse an emitted line and assert every gate magnitude + tie flag. Throws on mismatch. */
function assertLine(line: string, row: (Emitted | undefined)[], label: string): void {
  const steps = parseVoice(line, SECTION_STEPS);
  for (let i = 0; i < SECTION_STEPS; i++) {
    const want = row[i]; const got = steps[i];
    if (want === undefined) { if (got.on) throw new Error(`${label} step ${i}: expected rest, parsed a hit`); continue; }
    if (!got.on) throw new Error(`${label} step ${i}: expected a hit, parsed a rest`);
    const wantSixths = want.gateSteps * GATE_SIXTHS_PER_STEP;
    if (got.gate_sixths !== wantSixths) throw new Error(`${label} step ${i}: gate ${got.gate_sixths} != ${wantSixths}`);
    if ((got.tie === true) !== want.tie) throw new Error(`${label} step ${i}: tie ${got.tie === true} != ${want.tie}`);
  }
}

/** A copy of the template with the project name pre-set, so ONE write lands the right name. */
function namedTemplate(name: string): string {
  if (name.length > NAME_LEN) throw new Error(`name "${name}" is ${name.length} chars; the field holds ${NAME_LEN}`);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`name "${name}" has non-printable-ASCII characters`);
  mkdirSync(TPL_DIR, { recursive: true });
  const buf = Buffer.from(readFileSync(TEMPLATE));
  for (let i = 0; i < NAME_LEN; i++) buf[NAME_OFF + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  const path = `${TPL_DIR}/${name.replace(/\s+/g, '_')}.ncs`;
  writeFileSync(path, buf);
  return path;
}

async function main(): Promise<void> {
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
  registerDevice(SPD_SX_DESCRIPTOR);

  console.log(`After Dark P3..P8 -> Pack ${devicePack}, projects ${SPECS.map((_, i) => FIRST_SLOT + i).join(', ')}`);
  console.log(PAYLOAD_ONLY ? 'MODE: PAYLOAD ONLY (no device contact at all)' : APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log(`MIDI 1 in Verse 2 / Bridge: ${MIDI1_VERSE === undefined ? 'UNDECIDED -> P4 and P7 are HELD, their slots stay empty' : MIDI1_VERSE === 'square' ? 'part 4 square lead' : 'EMPTY, by his decision. The retune engages only where the saw plays.'}`);
  console.log('');
  console.log('LISTENING NOTES, carry these to the build doc:');
  console.log('  1. MIDI 1 is SILENT through Verse 2 (P4) and the Bridge (P7), and in P2 once it is');
  console.log('     cleared. That is CORRECT, not a failed write. The VE-500 has no retune target');
  console.log('     there and he sings free.');
  console.log('  2. OCTAVE, asymmetric and unresolved (HW-SPDSX-008): MIDI 2 is authored +12 so the');
  console.log('     drums land on the SPD-SX pads. MIDI 1 gets NO offset, and cannot: note_offset is');
  console.log('     an external_targets field and external_targets resolves a DRUM VOICE MAP, so it');
  console.log('     does not apply to a melodic pitch row. If the Circuit does transmit MIDI tracks');
  console.log('     an octave low, the chorus saw leaves at d#2..f3 (39-53) and ARRIVES at d#1..f2');
  console.log('     (27-41), ~39 Hz at the bottom. Unsingable. He answers this by ear on the first');
  console.log('     chorus; the fix would be transpose:12 on the melodic import, re-authored.');
  console.log('  3. THE INTERNAL DRUMS NOW SOUND. Pack 2\'s sample pool was cloned from Pack 1 on');
  console.log('     2026-07-27, 64 of 64 index-for-index, so the condensed Drum 1-4 tracks point at');
  console.log('     real samples. The old note that they stay silent because the pool is empty is');
  console.log('     WRONG and must not be carried forward. They are still stored at mixer level 0,');
  console.log('     so they are inaudible until he raises the faders, and then they play.');
  console.log('');

  // ── Phase 1: source, and the roster assertion ──────────────────────
  const parts = new Map<number, Awaited<ReturnType<typeof fetchSongsterrPart>>>();
  for (const p of [0, 2, 3, 4, 6]) parts.set(p, await fetchSongsterrPart(SONG, { track: p }));
  const any = parts.get(0)!;
  if (any.revisionId !== EXPECTED_REVISION) {
    console.log(`REFUSED: revision ${any.revisionId}, expected ${EXPECTED_REVISION}. The mapping is revision-specific.`);
    exitMidiScript(1);
  }
  for (const [idx, want] of Object.entries(ROSTER_EXPECT)) {
    const live = any.allTracks[Number(idx)];
    if (live === undefined || live.instrument !== want) {
      console.log(`REFUSED: part ${idx} is "${live?.instrument ?? 'missing'}", expected "${want}".`);
      exitMidiScript(1);
    }
  }
  console.log(`source OK: revision ${any.revisionId}, 7 parts, mapping matches`);
  console.log('');

  // ── Phase 2: build every project's sections ────────────────────────
  interface Built {
    label: string; name: string; slot: number; template: string;
    sections: { name: string; steps: number; voices: Record<string, string> }[];
    drums: boolean; expect: { track: NoteTrack; describe: string; check: (n: number[]) => boolean }[];
  }
  const projects: Built[] = [];
  let totalSplits = 0; const allClamps: string[] = []; let velocityDropped = 0;

  const held: string[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i];
    if (spec.held) {
      held.push(`${spec.label} (${spec.section} m${spec.from}-${spec.to}, slot ${FIRST_SLOT + i})`);
      console.log(`${spec.label} "${spec.name}"  ${spec.section.padEnd(8)} m${spec.from}-${spec.to}  slot ${FIRST_SLOT + i}  HELD: MIDI 1 undecided, slot left EMPTY`);
      continue;
    }
    const win = { fromMeasure: spec.from, toMeasure: spec.to, stepsPerBeat: 4 as const };
    const rows: Record<string, string[]> = {};
    const expect: Built['expect'] = [];
    const summary: string[] = [];

    for (const [part, voice] of spec.melodic) {
      const r = importSongsterrMelodic(parts.get(part)!.part, win);
      if (r.off_grid > 0 || r.merged > 0 || r.chord_overflow > 0 || r.unresolved > 0) {
        console.log(`REFUSED: ${spec.label} part ${part} fidelity regressed (off_grid=${r.off_grid} merged=${r.merged} overflow=${r.chord_overflow} unresolved=${r.unresolved}).`);
        exitMidiScript(1);
      }
      if (r.cells.length === 0) {
        console.log(`REFUSED: ${spec.label} part ${part} -> ${voice} is EMPTY over m${spec.from}-${spec.to}. The mapping and the occupancy disagree.`);
        exitMidiScript(1);
      }
      velocityDropped += r.cells.filter((c) => c.velocity !== undefined).length;
      const lines: string[] = [];
      for (let s = 0; s * SECTION_STEPS < r.step_count; s++) {
        const base = s * SECTION_STEPS;
        const { row, splits, clamps } = layoutSection(r.cells.filter((c) => c.step >= base && c.step < base + SECTION_STEPS), base);
        const line = render(row);
        assertLine(line, row, `${spec.label}/${voice}/S${s + 1}`);
        totalSplits += splits;
        allClamps.push(...clamps.map((c) => `${spec.label} ${voice} S${s + 1}: ${c}`));
        lines.push(line);
      }
      rows[voice] = lines;
      // BINDING GUARD: the read-back range assertion is built from THIS part's
      // own measured window, so it cannot pass if the track holds another part.
      const lo = r.range!.low, hi = r.range!.high;
      expect.push({
        track: voice as NoteTrack,
        describe: `part ${part} ${r.range!.low_name}..${r.range!.high_name}`,
        check: (n) => n.length > 0 && Math.min(...n) === lo && Math.max(...n) === hi,
      });
      summary.push(`${voice}=p${part}:${r.cells.length}c ${r.range!.low_name}..${r.range!.high_name}`);
    }

    if (spec.drums) {
      const d = importSongsterrDrums(parts.get(6)!.part, win);
      let hits = 0;
      for (const [voice, steps] of Object.entries(d.voices)) {
        if (!steps.some((x) => x.on)) continue;
        hits += steps.filter((x) => x.on).length;
        const lines: string[] = [];
        for (let s = 0; s * SECTION_STEPS < d.steps; s++) {
          // Char grid, no `:len`: SPD-SX pads are one-shots and ignore gate.
          lines.push(steps.slice(s * SECTION_STEPS, (s + 1) * SECTION_STEPS).map((x) => (x.on ? 'x' : '.')).join(''));
        }
        rows[voice] = lines;
      }
      if (hits === 0) { console.log(`REFUSED: ${spec.label} declares drums but the window has 0 hits.`); exitMidiScript(1); }
      expect.push({ track: 'midi2' as NoteTrack, describe: 'drums authored 48/50/54', check: (n) => n.length > 0 && n.every((x) => x === 48 || x === 50 || x === 54) });
      summary.push(`midi2=p6:${hits}h +condensed`);
    }

    const count = Math.max(...Object.values(rows).map((l) => l.length));
    const sections = Array.from({ length: count }, (_, s) => ({
      name: `S${s + 1}`, steps: SECTION_STEPS,
      voices: Object.fromEntries(Object.entries(rows).filter(([, l]) => l[s] !== undefined && /[^~.\s]/.test(l[s])).map(([v, l]) => [v, l[s]])),
    }));
    const emptySections = sections.filter((s) => Object.keys(s.voices).length === 0).map((s) => s.name);
    projects.push({ label: spec.label, name: spec.name, slot: FIRST_SLOT + i, template: namedTemplate(spec.name), sections, drums: spec.drums, expect });
    console.log(`${spec.label} "${spec.name}"  ${spec.section.padEnd(8)} m${spec.from}-${spec.to}  slot ${FIRST_SLOT + i}  ${sections.length} sections`);
    console.log(`     ${summary.join('   ')}`);
    if (emptySections.length) console.log(`     note: ${emptySections.length} section(s) with no content: ${emptySections.join(', ')}`);
  }
  console.log('');
  if (held.length) console.log(`HELD, pending the MIDI 1 decision: ${held.join('; ')}\n`);
  console.log(`payload verified: ${totalSplits} tie split(s), ${allClamps.length} unresolvable clamp(s), 0 parse mismatches`);
  for (const c of allClamps) console.log(`  CLAMP ${c}`);
  if (velocityDropped > 0) console.log(`  NOTE: ${velocityDropped} cell(s) carry a source velocity; mini-notation has no velocity suffix, so they author at the default.`);
  console.log('');
  if (PAYLOAD_ONLY) { console.log('PAYLOAD ONLY: stopping before any device contact.'); return; }

  // ── Phase 3: DEVICE survey. Refuse on occupied AND on unreadable. ──
  const conn = ensureConnection('circuit');
  const wirePack = devicePack - 1;

  const dir = await readDirectoryStable(conn, wirePack);
  console.log(`Pack ${devicePack} project directory: ${dir.occupied} of ${dir.total} occupied`);
  // `slots` is all 64; `name` is undefined for an EMPTY slot. Keying occupancy
  // off the array itself marks every slot occupied, which is a false refusal.
  const occupiedSet = new Map(dir.slots.filter((s) => s.name !== undefined).map((s) => [s.slot + 1, s.name!]));
  for (const [slot, name] of occupiedSet) console.log(`   project ${String(slot).padStart(2)}  "${name}"`);
  if (occupiedSet.size !== dir.occupied) {
    console.log(`REFUSED: directory disagrees with itself (${occupiedSet.size} named vs occupied=${dir.occupied}). Unreadable is a refusal.`);
    exitMidiScript(1);
  }
  let refuse = false;
  for (const p of projects) {
    if (occupiedSet.has(p.slot)) {
      console.log(`REFUSED: Pack ${devicePack} project ${p.slot} holds "${occupiedSet.get(p.slot)}". This device has no delete; pick an empty slot.`);
      refuse = true;
    }
  }
  if (refuse) exitMidiScript(1);
  console.log(`targets ${projects.map((p) => p.slot).join(', ')} are FREE`);
  // Held slots are RESERVED, not written. Report their state so a later run
  // knows whether the reservation still holds.
  for (let i = 0; i < SPECS.length; i++) {
    if (!SPECS[i].held) continue;
    const slot = FIRST_SLOT + i;
    const who = occupiedSet.get(slot);
    console.log(`reserved for ${SPECS[i].label}: project ${slot} is ${who !== undefined ? `OCCUPIED by "${who}" - the reservation is GONE` : 'free'}`);
  }

  const pool = await readSampleDirectory(conn, wirePack);
  console.log(`Pack ${devicePack} sample pool: ${pool.occupied} of ${pool.total} occupied`);
  console.log('  condensed-drum binding is the default [0,1,2,3] = Drum 1..4:');
  for (const slot of [0, 1, 2, 3]) {
    const hit = pool.slots.find((s) => s.slot === slot);
    console.log(`   Drum ${slot + 1} <- sample slot ${slot + 1}: ${hit?.name !== undefined ? `"${hit.name}"` : 'EMPTY'}`);
  }
  console.log('');

  // ── Phase 4: author ────────────────────────────────────────────────
  for (const p of projects) {
    const res = await executeApplyPattern({
      port: 'circuit-tracks', mode: 'ncs_upload', bpm: BPM,
      pack: devicePack, ncs_slot: p.slot, ncs_template: p.template,
      backup_first: true,
      // confirm_overwrite is DELIBERATELY absent: it is the switch that turns
      // off gateProjectOverwrite's own occupancy check, and there is no delete.
      dry_run: !APPLY,
      arrangement: { sections: p.sections },
      ...(p.drums ? {
        external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }],
        condense_drums: true,
      } : {}),
    });
    console.log(`${p.label} -> Pack ${devicePack} project ${p.slot}: ${res.status} ok=${res.ok}`);
    if (res.warning) console.log(`   warning: ${res.warning}`);
    if (res.info) console.log(`   ${res.info}`);
    if (!res.ok) { console.log(`\nFAIL-STOP on ${p.label}. Nothing further will be written.`); exitMidiScript(1); }
    console.log('');
  }

  if (!APPLY) { console.log('DRY RUN complete. Re-run with --apply to write.'); endMidiScript(); return; }

  // ── Phase 5: independent read-back with a BINDING GUARD ────────────
  console.log('read-back verification (independent download, not the write receipt)');
  console.log(`   settling ${SETTLE_MS / 1000}s for the pack manifest flush before verifying...`);
  await sleep(SETTLE_MS);
  let allOk = true;
  for (const p of projects) {
    const r = await downloadStable(conn, p.slot, wirePack, p.label);
    if (!r.ok || !r.crcOk || r.bytes === undefined) {
      console.log(`  ${p.label}  READ-BACK FAILED (ok=${r.ok} crcOk=${r.crcOk})`); allOk = false; continue;
    }
    const b = r.bytes;
    const name = Buffer.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).toString('ascii').replace(/\0.*$/, '').trim();
    const nameOk = name === p.name;
    if (!nameOk) allOk = false;
    console.log(`  ${p.label}  project ${p.slot}  name "${name}" ${nameOk ? 'OK' : `FAIL (wanted "${p.name}")`}  CRC ok`);
    for (const exp of p.expect) {
      const notes: number[] = [];
      let gated = 0, tied = 0;
      for (let pat = 0; pat < p.sections.length; pat++) {
        for (const st of decodeNotePattern(b, exp.track, pat)) {
          for (const sl of st.notes) { notes.push(sl.note); if (sl.gate !== 6) gated++; if (sl.tie) tied++; }
        }
      }
      const ok = exp.check(notes);
      if (!ok) allOk = false;
      const lo = notes.length ? Math.min(...notes) : 0, hi = notes.length ? Math.max(...notes) : 0;
      console.log(`     ${exp.track.padEnd(7)} ${ok ? 'OK  ' : 'FAIL'} ${notes.length} notes, ${lo}..${hi}, ${gated} non-default gates, ${tied} tie flags   [expected ${exp.describe}]`);
    }
    // Tracks this project should NOT hold must be genuinely empty.
    const written = new Set(p.expect.map((e) => e.track as string));
    for (const t of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
      if (written.has(t)) continue;
      let n = 0;
      for (let pat = 0; pat < p.sections.length; pat++) for (const st of decodeNotePattern(b, t, pat)) n += st.notes.length;
      if (n !== 0) { console.log(`     ${t.padEnd(7)} FAIL ${n} notes on a track this project should leave EMPTY`); allOk = false; }
      else console.log(`     ${t.padEnd(7)} OK   empty, as intended`);
    }
    let hits = 0;
    for (let t = 0; t < 4; t++) for (let pat = 0; pat < p.sections.length; pat++) hits += decodeDrumPattern(b, t, pat).filter((s) => s.active).length;
    console.log(`     drums   ${hits} condensed internal hit(s) across Drum 1..4${p.drums ? '' : ' (expected 0)'}`);
    if (!p.drums && hits !== 0) { console.log('     FAIL: condensed drums present on a drumless project'); allOk = false; }
    const chain = getNoteChain(b, 'synth2');
    console.log(`     chain   synth2 ${chain ? `[${chain.start}, ${chain.end}]` : '(none read)'}`);
  }
  console.log(allOk ? '\nREAD-BACK VERDICT: PASS, every track holds the part it should.' : '\nREAD-BACK VERDICT: FAIL. Investigate before playing.');
  endMidiScript(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
