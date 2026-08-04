/**
 * circuit-after-dark-author.ts: author "After Dark" (Mr.Kitty) onto the Circuit
 * Tracks, two projects, from the Songsterr source with real note lengths.
 *
 * Build record + every decision: `docs/_private/rig/songs/after-dark.md`.
 *
 * ## Why a standalone script and not the `apply_pattern` MCP tool
 *
 * The running MCP server process was started BEFORE commit e7135cb, which fixed
 * two `@julusian/midi` lifecycle bugs (an `Input.openPort()` ThreadSafeFunction
 * pinning the loop, and `close()` shutting the input before the output so a
 * throwing input close stranded the OUTPUT port for the process lifetime). A
 * running child does not reload `dist/`, so that process is executing the OLD
 * transport and its Circuit handle is wedged: the port enumerates but will not
 * open, and `reconnect_midi` cannot recover it because it fails its own
 * `isPortOpen()` assertion against our own leaked handle.
 *
 * Run under `npx tsx`, this script opens its own connection from CURRENT source
 * and therefore gets the FIXED transport. Same pattern as the Breakdown groove
 * fix and the Sugar gate restore / sub-bass rebind.
 *
 * It calls `executeApplyPattern` directly, which is the SAME code path the MCP
 * tool handler calls: the compile, the condenser, the external routing and the
 * overwrite gate are all the shipped ones, not a reimplementation. Only the
 * process is different.
 *
 * ## Why a whole-project write is right here (and is not, elsewhere)
 *
 * `mode: 'ncs_upload'` is a whole-project REWRITE: it writes the scale, every
 * touched pattern's length byte, and through the arrangement path the chain plus
 * an empty-fill, templating from a FILE rather than from the device. The Sugar
 * jobs had to go byte-surgical because they edited INSIDE existing projects and
 * had to preserve what they did not own. Here both targets are verified-EMPTY
 * slots, so there is nothing to preserve and a whole-project write is exactly
 * what is wanted.
 *
 * That inverts the moment a target is NOT empty, so:
 *
 * ## The empty check is a hard refuse-gate, in two independent layers
 *
 *  1. THIS script reads the target pack's project directory first and refuses
 *     if either slot is occupied, or if the directory read fails at all.
 *     Unreadable is a refusal, not a shrug.
 *  2. `confirm_overwrite` is NEVER passed, so `gateProjectOverwrite` in the
 *     writer independently re-reads occupancy at write time, on the same pack
 *     the write lands on, and refuses on occupied AND on unreadable.
 *
 * There is no decoded delete on this device: a slot written is written until
 * something overwrites it. Neither layer may be bypassed from the command line.
 *
 * ## Note lengths
 *
 * Gates come from the source: a cell's sounding length (ties folded in) becomes
 * a `:len` suffix. Past the 16-step gate ceiling it becomes a TIE SPLIT, `:16_`
 * plus a re-articulation of the identical token, which is the device's own
 * documented drone recipe. Every emitted line is re-parsed and asserted before
 * anything is sent. Drum voices carry no gates on purpose: the SPD-SX pads are
 * one-shots and ignore note length.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-author.ts               # survey + dry run
 *   npx tsx scripts/circuit-after-dark-author.ts --apply       # author
 *   npx tsx scripts/circuit-after-dark-author.ts --pack 3 --apply
 */
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
const devicePack = Number(flag('--pack') ?? '2');
const SLOT_P1 = Number(flag('--slot1') ?? '1');
const SLOT_P2 = Number(flag('--slot2') ?? '2');

const SONG = '501859';
const EXPECTED_REVISION = 4102120;
const BPM = 140;
const SECTION_STEPS = 32;
const MAX_GATE_STEPS = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;   // 16
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/** The settled mapping. Asserted against the live roster before anything else. */
const ROSTER_EXPECT: Record<number, string> = {
  0: 'Synth Bass 1', 1: 'Acoustic Grand Piano', 2: 'Pad 2 (warm)',
  3: 'Lead 2 (sawtooth)', 4: 'Lead 1 (square)', 5: 'Acoustic Grand Piano', 6: 'Drums',
};

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
    let pieces = 0;
    while (remaining > MAX_GATE_STEPS) {
      const next = at + MAX_GATE_STEPS;
      if (next >= SECTION_STEPS || row[next] !== undefined) break;
      row[at] = { token, gateSteps: MAX_GATE_STEPS, tie: true };
      pieces++; remaining -= MAX_GATE_STEPS; at = next;
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

async function main(): Promise<void> {
  // The dispatcher resolves ports through its own registry, which the MCP
  // server populates at boot. A standalone script has to do it itself; the
  // SPD-SX is needed because external_targets resolves its voice map (pure
  // data, no connection to that device).
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
  registerDevice(SPD_SX_DESCRIPTOR);

  console.log(`After Dark -> Pack ${devicePack}, projects ${SLOT_P1} and ${SLOT_P2}`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log('');

  // ── Phase 1: source, and the roster assertion ──────────────────────
  const parts = new Map<number, Awaited<ReturnType<typeof fetchSongsterrPart>>>();
  for (const p of [0, 2, 4, 5, 6]) parts.set(p, await fetchSongsterrPart(SONG, { track: p }));
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

  // ── Phase 2: build both projects' sections ─────────────────────────
  interface Built { label: string; slot: number; sections: { name: string; steps: number; voices: Record<string, string> }[]; drums: boolean }
  const projects: Built[] = [];
  let totalSplits = 0; const allClamps: string[] = []; let velocityDropped = 0;

  for (const spec of [
    { label: 'P1', slot: SLOT_P1, window: { fromMeasure: 1, toMeasure: 16 }, melodic: [{ part: 5, voice: 'synth2' }], drums: false },
    { label: 'P2', slot: SLOT_P2, window: { fromMeasure: 19, toMeasure: 34 }, melodic: [{ part: 0, voice: 'synth1' }, { part: 2, voice: 'synth2' }, { part: 4, voice: 'midi1' }], drums: true },
  ] as const) {
    const rows: Record<string, string[]> = {};
    for (const m of spec.melodic) {
      const r = importSongsterrMelodic(parts.get(m.part)!.part, { ...spec.window, stepsPerBeat: 4 });
      if (r.off_grid > 0 || r.merged > 0 || r.chord_overflow > 0 || r.unresolved > 0) {
        console.log(`REFUSED: part ${m.part} fidelity regressed (off_grid=${r.off_grid} merged=${r.merged} overflow=${r.chord_overflow} unresolved=${r.unresolved}).`);
        exitMidiScript(1);
      }
      velocityDropped += r.cells.filter((c) => c.velocity !== undefined).length;
      const lines: string[] = [];
      for (let s = 0; s * SECTION_STEPS < r.step_count; s++) {
        const base = s * SECTION_STEPS;
        const { row, splits, clamps } = layoutSection(r.cells.filter((c) => c.step >= base && c.step < base + SECTION_STEPS), base);
        const line = render(row);
        assertLine(line, row, `${spec.label}/${m.voice}/S${s + 1}`);
        totalSplits += splits;
        allClamps.push(...clamps.map((c) => `${spec.label} ${m.voice} S${s + 1}: ${c}`));
        lines.push(line);
      }
      rows[m.voice] = lines;
    }
    if (spec.drums) {
      const d = importSongsterrDrums(parts.get(6)!.part, { ...spec.window, stepsPerBeat: 4 });
      for (const [voice, steps] of Object.entries(d.voices)) {
        if (!steps.some((x) => x.on)) continue;
        const lines: string[] = [];
        for (let s = 0; s * SECTION_STEPS < d.steps; s++) {
          // Char grid, no `:len`: SPD-SX pads are one-shots and ignore gate.
          lines.push(steps.slice(s * SECTION_STEPS, (s + 1) * SECTION_STEPS).map((x) => (x.on ? 'x' : '.')).join(''));
        }
        rows[voice] = lines;
      }
    }
    const count = Math.max(...Object.values(rows).map((l) => l.length));
    const sections = Array.from({ length: count }, (_, s) => ({
      name: `S${s + 1}`, steps: SECTION_STEPS,
      voices: Object.fromEntries(Object.entries(rows).filter(([, l]) => l[s] !== undefined && /[^~.\s]/.test(l[s])).map(([v, l]) => [v, l[s]])),
    })).filter((s) => Object.keys(s.voices).length > 0 || true);
    projects.push({ label: spec.label, slot: spec.slot, sections, drums: spec.drums });
    console.log(`${spec.label}: ${sections.length} sections, voices [${[...new Set(sections.flatMap((s) => Object.keys(s.voices)))].join(', ')}]`);
  }
  console.log(`payload verified: ${totalSplits} tie split(s), ${allClamps.length} unresolvable clamp(s), 0 parse mismatches`);
  for (const c of allClamps) console.log(`  CLAMP ${c}`);
  if (velocityDropped > 0) console.log(`  NOTE: ${velocityDropped} cell(s) carry a source velocity; mini-notation has no velocity suffix, so they author at the default.`);
  console.log('');

  // ── Phase 3: DEVICE survey. Refuse on occupied AND on unreadable. ──
  const conn = ensureConnection('circuit');
  const wirePack = devicePack - 1;

  const dir = await readProjectDirectory(conn, wirePack);
  console.log(`Pack ${devicePack} project directory: ${dir.occupied} of ${dir.total} occupied`);
  // `slots` is all 64; `name` is undefined for an EMPTY slot (DirectorySlot).
  // Keying occupancy off the array itself marks every slot occupied, which is a
  // false refusal. Occupancy IS the presence of a name.
  const occupiedSet = new Map(dir.slots.filter((s) => s.name !== undefined).map((s) => [s.slot + 1, s.name!]));
  if (occupiedSet.size === 0) console.log('   (no occupied slots: this pack is empty)');
  for (const [slot, name] of occupiedSet) console.log(`   project ${String(slot).padStart(2)}  "${name}"`);
  if (occupiedSet.size !== dir.occupied) {
    console.log(`REFUSED: directory disagrees with itself (${occupiedSet.size} named vs occupied=${dir.occupied}). Unreadable is a refusal.`);
    exitMidiScript(1);
  }
  let refuse = false;
  for (const slot of [SLOT_P1, SLOT_P2]) {
    if (occupiedSet.has(slot)) {
      console.log(`REFUSED: Pack ${devicePack} project ${slot} holds "${occupiedSet.get(slot)}". This device has no delete; pick an empty slot.`);
      refuse = true;
    }
  }
  if (refuse) exitMidiScript(1);
  console.log(`projects ${SLOT_P1} and ${SLOT_P2} are FREE (absent from the directory listing)`);

  const pool = await readSampleDirectory(conn, wirePack);
  console.log(`\nPack ${devicePack} sample pool: ${pool.occupied} of ${pool.total} occupied`);
  const named = pool.slots.filter((s) => s.name !== undefined);
  for (const s of named.slice(0, 12)) console.log(`   sample ${String(s.slot + 1).padStart(2)}  "${s.name}"`);
  if (named.length > 12) console.log(`   ... ${named.length - 12} more`);
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
      pack: devicePack, ncs_slot: p.slot, ncs_template: TEMPLATE,
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
    if (!res.ok) { console.log(`\nFAIL-STOP on ${p.label}.`); exitMidiScript(1); }
    console.log('');
  }

  if (!APPLY) { console.log('DRY RUN complete. Re-run with --apply to write.'); endMidiScript(); return; }

  // ── Phase 5: independent read-back with a BINDING GUARD ────────────
  console.log('read-back verification (independent download, not the write receipt)');
  const expectTracks: Record<string, { track: NoteTrack; describe: string; check: (notes: number[]) => boolean }[]> = {
    P1: [{ track: 'synth2', describe: 'piano d#3..f4', check: (n) => n.length > 0 && Math.min(...n) >= 48 && Math.max(...n) <= 68 }],
    P2: [
      { track: 'synth1', describe: 'bass d#1/g1 only', check: (n) => n.length > 0 && n.every((x) => x === 27 || x === 31) },
      { track: 'synth2', describe: 'pad chords d#2..d4', check: (n) => n.length > 0 && Math.min(...n) >= 36 && Math.max(...n) <= 64 },
      { track: 'midi1', describe: 'square lead a#2..d#3', check: (n) => n.length > 0 && Math.min(...n) >= 44 && Math.max(...n) <= 53 },
      { track: 'midi2', describe: 'drums authored 48/50/54', check: (n) => n.length > 0 && n.every((x) => x === 48 || x === 50 || x === 54) },
    ],
  };
  let allOk = true;
  for (const p of projects) {
    const r = await downloadProject(conn, p.slot - 1, { pack: wirePack, reconnect: () => connect(CONNECT) });
    if (!r.ok || !r.crcOk || r.bytes === undefined) {
      console.log(`  ${p.label}  READ-BACK FAILED (ok=${r.ok} crcOk=${r.crcOk})`); allOk = false; continue;
    }
    const b = r.bytes;
    const name = Buffer.from(b.slice(0x10, 0x20)).toString('ascii').replace(/\0.*$/, '').trim();
    console.log(`  ${p.label}  project ${p.slot}  name "${name}"  CRC ok`);
    for (const exp of expectTracks[p.label]) {
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
    if (p.drums) {
      let hits = 0;
      for (let t = 0; t < 4; t++) for (let pat = 0; pat < p.sections.length; pat++) hits += decodeDrumPattern(b, t, pat).filter((s) => s.active).length;
      console.log(`     drums   ${hits} condensed internal hit(s) across Drum 1..4`);
    }
    const chain = getNoteChain(b, 'synth2');
    console.log(`     chain   synth2 ${chain ? `[${chain.start}, ${chain.end}]` : '(none read)'}`);
  }
  console.log(allOk ? '\nREAD-BACK VERDICT: PASS, every track holds the part it should.' : '\nREAD-BACK VERDICT: FAIL. Investigate before playing.');
  endMidiScript(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
