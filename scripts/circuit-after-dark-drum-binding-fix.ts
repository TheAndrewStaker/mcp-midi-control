/**
 * circuit-after-dark-drum-binding-fix.ts — point After Dark's condensed internal
 * drum tracks at the samples their ROLES actually ask for on Pack 2.
 *
 * ## The bug, measured
 *
 * `condense_drums` binds Drum 1..4 from `CIRCUIT_VOICE_SLOT`, which says
 * kick/snare/closed_hat/ride live at pool slots 0/1/2/3. That is true only of a
 * ROLE-ORDERED pool that we uploaded ourselves. Pack 2's pool is an
 * index-for-index clone of Pack 1's, which is a stock multi-kit pool whose slot 0
 * is the factory placeholder `00_PCM.wav`, so the first kit (`stoken_4`) sits at
 * slots 1..15 — shifted up one, with its own `01_kick` displaced off the pool
 * entirely. Binding 0/1/2/3 therefore plays:
 *
 *   Drum 1 kick       -> slot 0  "00_PCM.wav"                 a placeholder
 *   Drum 2 snare      -> slot 1  "01_stoken_4_02_kick2.wav"   a KICK
 *   Drum 3 closed_hat -> slot 2  "02_stoken_4_03_snr.wav"     a SNARE
 *   Drum 4 ride       -> slot 3  "03_stoken_4_04_sidestk.wav" a SIDE STICK
 *
 * i.e. every voice is one kit-piece late. Fixed by binding each role to the slot
 * that genuinely holds that sound, all four from the SAME kit (`stoken_4`) so the
 * condensed kit is timbrally coherent:
 *
 *   Drum 1 kick       -> slot  1  "01_stoken_4_02_kick2.wav"
 *   Drum 2 snare      -> slot  2  "02_stoken_4_03_snr.wav"
 *   Drum 3 closed_hat -> slot  5  "05_stoken_4_06_hatC.wav"
 *   Drum 4 ride       -> slot 11  "11_stoken_4_12_ride.wav"
 *
 * The kick is the kit's `kick2` because the kit's `01_kick` is NOT in this pool
 * (slot 0 is the placeholder). `kick2` is a real kick from the same kit, which is
 * the right call over borrowing `16_stoken_1_01_kick.wav` from a different kit.
 *
 * ## Scope: only projects that carry the condensed copy
 *
 * Decided from the DEVICE read, never from a list: a project is rewritten only if
 * its four drum tracks actually hold hits. Projects with no condensed content keep
 * whatever binding the device gave them — they are untouched device defaults and
 * rewriting them would be an unrequested change.
 *
 * ## What is NOT touched
 *
 * Drum LEVELS stay exactly as stored (0 on the condensed projects, by design —
 * the internal kit is a blend layer under the SPD-SX on MIDI 2, and raising it is
 * a mixer choice at the device, not something to bake in). Patterns, note tracks,
 * tempo, name, scale and mixer levels are all untouched.
 *
 * ## Refusals (each is a stop, never a retry)
 *
 *  - Bad CRC, or a name that is not "AfterDark P<n>".
 *  - The pool does not hold the expected sample name at a target slot.
 *  - ANY per-step sample flip (`drum_choice` != 0xFF) exists: flips are absolute
 *    pool slots too, so a binding-only fix would leave them stale. Refuse rather
 *    than ship half a fix.
 *  - Any planned edit outside the 4 binding bytes.
 *  - On read-back: any wrong byte, ANY collateral byte, any decoded drum step or
 *    note step that moved, any drum level change, or any name/tempo/scale/mixer
 *    change.
 *
 * Reads settle past the Circuit's 6-to-8s pack-manifest flush before the first
 * read and before every verify.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-drum-binding-fix.ts            # dry run
 *   npx tsx scripts/circuit-after-dark-drum-binding-fix.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeDrumPattern, type DrumStep } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  DRUM_BINDING_OFFSET, DRUM_TRACK_BASE_VOICES, NUM_DRUM_TRACKS, MAX_SAMPLE_SLOT,
  getDrumSampleBinding, setDrumSampleBinding,
} from '../packages/circuit-tracks/src/ncs/drumBinding.js';
import {
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, getDrumLevel, getProjectTempo,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { SCALE_TYPE_OFFSET, SCALE_ROOT_OFFSET, SCALE_NAMES } from '../packages/circuit-tracks/src/ncs/scale.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '2');
const MANIFEST = flag('--manifest')
  ?? 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z/manifest.json';

const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NAME_OFF = 0x10, NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const NO_FLIP = 0xff;

/**
 * The verified binding. Each entry is asserted against the pool's own name below,
 * so a pool that is not what we think it is stops the run instead of writing.
 */
const TARGET: ReadonlyArray<{ role: string; slot: number; expect: string }> = [
  { role: 'kick', slot: 1, expect: '01_stoken_4_02_kick2.wav' },
  { role: 'snare', slot: 2, expect: '02_stoken_4_03_snr.wav' },
  { role: 'closed_hat', slot: 5, expect: '05_stoken_4_06_hatC.wav' },
  { role: 'ride', slot: 11, expect: '11_stoken_4_12_ride.wav' },
];
const TARGET_SLOTS = TARGET.map((t) => t.slot);

const hex = (n: number): string => `0x${n.toString(16)}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const WRITABLE = new Set<number>(
  Array.from({ length: NUM_DRUM_TRACKS }, (_, t) => DRUM_BINDING_OFFSET + t),
);

console.log(`After Dark, Pack ${devicePack}: bind the condensed drum tracks to the samples their ROLES ask for`);
console.log(`  writable set: ${WRITABLE.size} byte(s) of 160780 — ${[...WRITABLE].map(hex).join(', ')}`);
console.log('  drum LEVELS, patterns, note tracks, tempo, name, scale and mixer are NOT touched.');
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
console.log('');

// ── 1. Prove the pool actually holds these sounds ────────────────────
const poolNames = ((): Map<number, string> => {
  const out = new Map<number, string>();
  if (!existsSync(MANIFEST)) return out;
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    packs: { device_pack: number; samples?: { wire_slot: number; name: string }[] }[];
  };
  const p = m.packs.find((x) => x.device_pack === devicePack);
  for (const s of p?.samples ?? []) out.set(s.wire_slot, s.name);
  return out;
})();

console.log(`pool: ${MANIFEST} — pack ${devicePack}, ${poolNames.size} slot name(s) read from the device`);
if (poolNames.size === 0) { console.error('REFUSED: no pool names; cannot prove the binding points at real sounds.'); process.exit(1); }
let poolBad = 0;
for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
  const want = TARGET[t]!;
  const got = poolNames.get(want.slot);
  const ok = got === want.expect;
  if (!ok) poolBad++;
  if (want.role !== DRUM_TRACK_BASE_VOICES[t]) {
    console.error(`REFUSED: track ${t + 1} target role "${want.role}" != DRUM_TRACK_BASE_VOICES "${DRUM_TRACK_BASE_VOICES[t]}".`);
    process.exit(1);
  }
  if (!Number.isInteger(want.slot) || want.slot < 0 || want.slot > MAX_SAMPLE_SLOT) {
    console.error(`REFUSED: slot ${want.slot} out of range.`); process.exit(1);
  }
  console.log(`  Drum ${t + 1}  role ${want.role.padEnd(11)} -> slot ${String(want.slot).padStart(2)}  "${got ?? '(EMPTY)'}"  ${ok ? 'OK' : `*** expected "${want.expect}" ***`}`);
}
if (poolBad > 0) { console.error(`\nREFUSED: ${poolBad} target slot(s) do not hold the expected sample. Not writing.`); process.exit(1); }
console.log('');

// ── 2. Snapshots used for the collateral proof ───────────────────────
interface DrumSnap { steps: DrumStep[][]; hits: number; levels: number[]; flips: Set<number> }
function drumSnapshot(b: Uint8Array): DrumSnap {
  const steps: DrumStep[][] = [];
  const flips = new Set<number>();
  let hits = 0;
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const d = decodeDrumPattern(b, t, p);
      steps.push(d);
      for (const s of d) {
        if (s.active) hits++;
        if (s.drumChoice !== NO_FLIP) flips.add(s.drumChoice);
      }
    }
  }
  const levels = Array.from({ length: NUM_DRUM_TRACKS }, (_, t) => getDrumLevel(b, t));
  return { steps, hits, levels, flips };
}
const perTrackHits = (b: Uint8Array): number[] =>
  Array.from({ length: NUM_DRUM_TRACKS }, (_, t) => {
    let n = 0;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const s of decodeDrumPattern(b, t, p)) if (s.active) n++;
    return n;
  });

/** Decoded per-slot comparison of every drum step — the real collateral proof. */
function drumStepsDiffer(a: DrumSnap, c: DrumSnap): string[] {
  const bad: string[] = [];
  for (let blk = 0; blk < a.steps.length; blk++) {
    const t = Math.floor(blk / PATTERNS_PER_TRACK), p = blk % PATTERNS_PER_TRACK;
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const x = a.steps[blk]![s]!, y = c.steps[blk]![s]!;
      if (x.active !== y.active || x.velocity !== y.velocity || x.probability !== y.probability
          || x.drumChoice !== y.drumChoice || x.microHits !== y.microHits) {
        bad.push(`D${t + 1}p${p + 1}s${s}`);
      }
    }
  }
  return bad;
}
/** Decoded per-slot comparison of every note step on all four melodic tracks. */
function noteStepsDiffer(before: Uint8Array, after: Uint8Array): string[] {
  const bad: string[] = [];
  for (const tr of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const x = decodeNotePattern(before, tr, p), y = decodeNotePattern(after, tr, p);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        const a = x[s]!, b = y[s]!;
        if (a.active !== b.active || a.slotMask !== b.slotMask || a.probability !== b.probability
            || a.notes.length !== b.notes.length
            || a.notes.some((n, i) => n.note !== b.notes[i]!.note || n.gate !== b.notes[i]!.gate
              || n.tie !== b.notes[i]!.tie || n.velocity !== b.notes[i]!.velocity)) {
          bad.push(`${tr}p${p + 1}s${s}`);
        }
      }
    }
  }
  return bad;
}

// ── 3. DEVICE ────────────────────────────────────────────────────────
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 9_000, POLL_MS = 5_000, MAX_POLLS = 6;

const readStable = async (slot: number, label: string): Promise<Awaited<ReturnType<typeof downloadProject>>> => {
  let last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  for (let i = 1; i <= MAX_POLLS && (!last.ok || !last.crcOk || last.bytes === undefined); i++) {
    console.log(`      ${label}: read ${i} came back ok=${last.ok} crcOk=${last.crcOk}; waiting ${POLL_MS / 1000}s and retrying (manifest flush, not a failure)`);
    await sleep(POLL_MS);
    last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  return last;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-afterdark-drumbind-${stamp}`;
if (APPLY) mkdirSync(backupDir, { recursive: true });

console.log(`settling ${SETTLE_MS / 1000}s for the pack-manifest flush before the first read...`);
await sleep(SETTLE_MS);

let written = 0, unchanged = 0, skipped = 0;
const backups: string[] = [];
for (let slot = 1; slot <= 8; slot++) {
  const tag = `P${slot}`;
  const r = await readStable(slot, tag);
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}. Unreadable is a refusal.`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }
  const before = r.bytes;
  const nm = nameOf(before);
  if (nm !== `AfterDark P${slot}`) {
    console.log(`  ${tag}  REFUSED: name is "${nm}", expected "AfterDark P${slot}".`);
    exitMidiScript(1);
  }
  const was = drumSnapshot(before);
  const bindBefore = getDrumSampleBinding(before);
  const each = perTrackHits(before);
  console.log(`  ${tag}  "${nm}"  CRC ok  tempo ${getProjectTempo(before)} BPM  ${was.hits} drum hit(s) [${each.join('/')}]  levels [${was.levels.join('/')}]`);
  console.log(`        binding BEFORE [${bindBefore.join(', ')}] = ${bindBefore.map((s) => poolNames.get(s) ?? '(EMPTY)').join(', ')}`);

  if (was.hits === 0) {
    console.log('        SKIP: no condensed content here; leaving the device\'s own binding alone.');
    skipped++;
    continue;
  }
  if (was.flips.size > 0) {
    console.log(`        REFUSED: ${was.flips.size} per-step sample flip(s) present (slots ${[...was.flips].join(',')}). Those are absolute pool slots too; a binding-only fix would leave them stale.`);
    exitMidiScript(1);
  }

  const after = new Uint8Array(before);
  setDrumSampleBinding(after, TARGET_SLOTS);
  const edits: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!WRITABLE.has(i)) { console.log(`        REFUSED: planned edit at ${hex(i)} is outside the 4 binding bytes.`); exitMidiScript(1); }
    edits.push(i);
  }
  console.log(`        binding AFTER  [${TARGET_SLOTS.join(', ')}] = ${TARGET_SLOTS.map((s) => poolNames.get(s) ?? '(EMPTY)').join(', ')}`);
  if (edits.length === 0) { console.log('        already exactly this; nothing to write.'); unchanged++; continue; }
  console.log(`        plan: ${edits.length} byte(s) at ${edits.map(hex).join(', ')}`);

  if (!APPLY) continue;

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`        REFUSED: backup ${backup} already exists.`); exitMidiScript(1); }
  writeFileSync(backup, before);
  backups.push(backup);
  console.log(`        backup: ${backup} (${before.length} bytes, full pre-edit project)`);

  const up = await uploadProject(conn, after, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`        UPLOAD FAILED: ${up.error ?? 'unknown'}. Original at ${backup}`);
    console.log(`\nFAIL-STOP after ${written} write(s).`);
    exitMidiScript(1);
  }

  console.log(`        settling ${SETTLE_MS / 1000}s past the manifest-flush window before the independent read-back...`);
  await sleep(SETTLE_MS);
  const v = await readStable(slot, `${tag} verify`);
  if (!v.ok || !v.crcOk || v.bytes === undefined) { console.log(`        VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`); exitMidiScript(1); }
  const got = v.bytes;

  const intended = new Set(edits);
  const wrong: string[] = [], collateral: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (intended.has(i)) { if (got[i] !== after[i]) wrong.push(`${hex(i)}=${got[i]} (wanted ${after[i]})`); }
    else if (got[i] !== before[i]) collateral.push(i);
  }
  const back = drumSnapshot(got);
  const bindBack = getDrumSampleBinding(got);
  const bindOk = bindBack.every((s, i) => s === TARGET_SLOTS[i]);
  const stepBad = drumStepsDiffer(was, back);
  const noteBad = noteStepsDiffer(before, got);
  const levelOk = back.levels.every((l, i) => l === was.levels[i]);
  const nameBack = nameOf(got), tempoBack = getProjectTempo(got);
  const mixOk = got[MIXER_SYNTH1_LEVEL] === before[MIXER_SYNTH1_LEVEL] && got[MIXER_SYNTH2_LEVEL] === before[MIXER_SYNTH2_LEVEL];
  const scaleOk = got[SCALE_TYPE_OFFSET] === before[SCALE_TYPE_OFFSET] && got[SCALE_ROOT_OFFSET] === before[SCALE_ROOT_OFFSET];

  console.log(`        read-back: ${edits.length - wrong.length}/${edits.length} intended byte(s) landed, collateral ${collateral.length}`);
  console.log(`                   binding [${bindBack.join(', ')}] ${bindOk ? 'AS INTENDED' : '*** WRONG ***'}  |  ${back.hits} drum hit(s) [${perTrackHits(got).join('/')}]  levels [${back.levels.join('/')}] ${levelOk ? 'unchanged' : '*** MOVED ***'}`);
  console.log(`                   decoded per-slot: drum steps ${stepBad.length === 0 ? 'IDENTICAL (1024 steps)' : `${stepBad.length} MOVED (${stepBad.slice(0, 4).join(', ')})`}  |  note steps ${noteBad.length === 0 ? 'IDENTICAL (1024 steps)' : `${noteBad.length} MOVED (${noteBad.slice(0, 4).join(', ')})`}`);
  console.log(`                   name "${nameBack}"  tempo ${tempoBack}  scale ${SCALE_NAMES[got[SCALE_TYPE_OFFSET]] ?? '?'}  mixer synth1=${got[MIXER_SYNTH1_LEVEL]} synth2=${got[MIXER_SYNTH2_LEVEL]}`);
  if (wrong.length > 0 || collateral.length > 0 || !bindOk || stepBad.length > 0 || noteBad.length > 0
      || !levelOk || nameBack !== nm || tempoBack !== getProjectTempo(before) || !mixOk || !scaleOk) {
    console.log(`        VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral at ${collateral.slice(0, 6).map(hex).join(', ')}`);
    console.log(`        restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`        PASS: ${edits.length} byte(s) of ${before.length} changed, all inside the binding field, ZERO collateral.`);
  written++;
  await sleep(400);
}

console.log('');
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${written} project(s) written, ${unchanged} already correct, ${skipped} skipped (no condensed content).`);
if (APPLY && backups.length > 0) {
  console.log('restore points:');
  for (const p of backups) console.log(`  ${p}`);
}
endMidiScript(0);
