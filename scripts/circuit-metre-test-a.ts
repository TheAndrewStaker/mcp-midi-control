/**
 * circuit-metre-test-a.ts — MIXED-LENGTH PATTERN CHAIN, hardware test A.
 *
 * THE QUESTION (docs/_private/rig/songs/schism-interview.md §3, and the gate on
 * every mixed-metre song): a Circuit pattern's LENGTH is per track per pattern
 * slot, 1..32 steps, and is hardware-confirmed as a stored byte. What has never
 * been tested is whether a CHAINED pattern advances when its OWN length elapses,
 * or on a fixed 32-step boundary — and whether two tracks stay together while
 * doing it. Every song shipped so far used a uniform 32.
 *
 * THE TEST. One throwaway project. Drums 1 and Synth 1, four patterns each at
 * lengths 24, 24, 30, 18 (Schism's own numbers: a 5/8+7/8 pair, a 3/4+6/8 pair,
 * a 9/8 bar). One hit on step 0 of every pattern, nothing else. Chain 0..3 on
 * both tracks. Played at 60 bpm a step is 250 ms, so the four gaps are 6.0 s,
 * 6.0 s, 7.5 s and 4.5 s — countable against the device's own quarter-note
 * click, which ticks once a second at that tempo.
 *
 *   PASS  the two sounds always land together, and the gaps run 6 / 6 / 7.5 /
 *         4.5 s: three hits ON a click and the fourth exactly BETWEEN two
 *         clicks, then back to the click.
 *   FAIL  an extra hit inside a gap (the pattern wrapped to its own step 0 and
 *         played on to 32 before advancing), or the two tracks drifting apart.
 *
 * The stored length bytes are then read back independently (23, 23, 29, 17 —
 * the field is steps-1), which is what separates "we failed to write the
 * lengths" from "the device ignores them". Those are different problems.
 *
 * WHY A STANDALONE SCRIPT. Same reason as circuit-after-dark-author.ts: it calls
 * `executeApplyPattern` directly, so the compile, the arrangement writer, the
 * length-byte write, the chain write and the overwrite gate are all the SHIPPED
 * ones rather than a reimplementation — only the process is different, so the
 * result is evidence about the product and not about this file.
 *
 * SAFETY
 *  - Target is Pack 3, the maintainer's disposable test pack (0 of 64 projects
 *    occupied in the 2026-07-27 card backup). Verified EMPTY at write time, not
 *    trusted from that reading, and read TWICE with a >9 s gap because the
 *    device flushes a pack manifest 6-8 s after a session closes.
 *  - `confirm_overwrite` is NEVER passed, so `gateProjectOverwrite` in the
 *    writer independently re-reads occupancy on the same pack and refuses on
 *    occupied AND on unreadable. There is no delete on this device.
 *  - Everything read before the write is written to an artifact directory, so
 *    the pre-write state of the pack is on disk even though the slot is empty.
 *  - Dry run by default; `--apply` required to write.
 *
 * THE SAMPLE. Pack 3's sample pool holds ONE sample (wire slot 5, a hat
 * crescendo) so Drum 1 under the default binding [0,1,2,3] would be SILENT, and
 * a 2.3 s crescendo is useless for timing anyway (its peak is at its end). This
 * uploads one short, dry SIDESTICK — the "click or rim" the test asks for, taken
 * from the card backup so the bytes are already device-format and device-proven
 * — into Pack 3 sample slot 1 (wire 0), which is where the default binding
 * points Drum 1. Skip with `--no-sample`.
 *
 * Usage:
 *   npx tsx scripts/circuit-metre-test-a.ts               # survey + dry run
 *   npx tsx scripts/circuit-metre-test-a.ts --apply       # author
 *   npx tsx scripts/circuit-metre-test-a.ts --apply --pack 3 --slot 1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { ensureConnection } from '../packages/core/src/server-shared/connections.js';
import { endMidiScript, exitMidiScript } from './_lib/midi-lifecycle.js';
import { readProjectDirectory, readSampleDirectory } from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { downloadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { uploadSample } from '../packages/circuit-tracks/src/samples/uploadSample.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import { DRUM_BINDING_OFFSET } from '../packages/circuit-tracks/src/ncs/drumBinding.js';
import { SCALE_TYPE_OFFSET, SCALE_CHROMATIC } from '../packages/circuit-tracks/src/ncs/scale.js';
import { META_OFFSETS, drumBlockIndex, noteBlockIndex } from '../packages/circuit-tracks/src/ncs/format.js';
import { executeApplyPattern, type ArrangementSectionArgs } from '../packages/core/src/protocol-generic/dispatcher/patterns.js';
import { registerDevice } from '../packages/core/src/protocol-generic/registry.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../packages/circuit-tracks/src/descriptor.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const NO_SAMPLE = argv.includes('--no-sample');
const devicePack = Number(flag('--pack') ?? '3');
const SLOT = Number(flag('--slot') ?? '1');           // DEVICE numbering, Project 1..64
const wirePack = devicePack - 1;

/** Schism's own numbers. A 5/8+7/8 pair, again, a 3/4+6/8 pair, a 9/8 bar. */
const LENGTHS = [24, 24, 30, 18] as const;
/** steps-1 is what the metadata byte stores. This is the read-back assertion. */
const EXPECT_LENGTH_BYTES = LENGTHS.map((s) => s - 1);
/** 60 bpm -> a step is 250 ms and the device's quarter-note click ticks once a second. */
const BPM = 60;
const PROJECT_NAME = 'MetreTest A';
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;         // 32 bytes, space-padded (the template is space-filled to 0x30)
const SYNTH_NOTE = 'c4';       // MIDI 60, the voice_map's own default register for synth1
const SYNTH_NOTE_MIDI = 60;
const SYNTH_GATE_STEPS = 2;    // 500 ms at 60 bpm: audible, still a sharp onset
const DRUM_TRACK = 0;          // Drum 1
const NOTE_TRACK = 'synth1' as const;
const CHAIN_SYNTH1 = 0x2c4;    // chain table slot 0
const CHAIN_DRUM1 = 0x2d4;     // chain table slot 4

/** Device-format WAV taken off the card in the 2026-07-27 backup: short, dry, unpitched. */
const SIDESTICK_SRC = 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z/pack1/samples/s03__03_stoken_4_04_sidestk.wav';
const SIDESTICK_WIRE_SLOT = 0;               // device Sample 1 = where DEFAULT_DRUM_BINDING points Drum 1
const SIDESTICK_FILENAME = '00_sidestick.wav'; // prefix matches the slot, as every device-written name does

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d\d\dZ$/, 'Z');
const ARTIFACTS = flag('--out') ?? `samples/circuit-ncs/metre-test-a-${STAMP}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** Space-padded 32-byte project name. Refuses anything that would not round-trip. */
function nameBytes(name: string): number[] {
  if (name.length > 16) throw new Error(`name "${name}" is ${name.length} chars; keep it <=16 so the device's 16-byte display field holds it whole`);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`name "${name}" has non-printable-ASCII characters`);
  return Array.from({ length: NAME_LEN }, (_, i) => (i < name.length ? name.charCodeAt(i) : 0x20));
}

/** One section: a single hit on step 0 of an n-step pattern, on Drum 1 and Synth 1. */
function section(index: number, steps: number): ArrangementSectionArgs {
  return {
    name: `P${index + 1}_${steps}`,
    steps,
    voices: {
      drum1: `x${'.'.repeat(steps - 1)}`,
      synth1: [`${SYNTH_NOTE}:${SYNTH_GATE_STEPS}`, ...Array.from({ length: steps - 1 }, () => '~')].join(' '),
    },
  };
}

interface DirSnapshot { occupied: number; total: number; named: { device_slot: number; name: string }[] }
const snapshot = (d: { occupied: number; total: number; slots: { slot: number; device_slot: number; name?: string }[] }): DirSnapshot => ({
  occupied: d.occupied, total: d.total,
  named: d.slots.filter((s) => s.name !== undefined).map((s) => ({ device_slot: s.device_slot, name: s.name! })),
});

async function main(): Promise<void> {
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);

  console.log(`Metre test A  ->  Pack ${devicePack}, Project ${SLOT}   lengths [${LENGTHS.join(', ')}]  chain 0..3  ${BPM} bpm`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log(`artifacts: ${ARTIFACTS}`);
  console.log('');

  if (!existsSync(TEMPLATE)) { console.log(`REFUSED: template ${TEMPLATE} is missing.`); exitMidiScript(1); }
  if (!NO_SAMPLE && !existsSync(SIDESTICK_SRC)) {
    console.log(`REFUSED: ${SIDESTICK_SRC} is missing. Re-run with --no-sample to author a SILENT Drum 1, or point at another device-format WAV.`);
    exitMidiScript(1);
  }
  mkdirSync(ARTIFACTS, { recursive: true });

  // ── Phase 1: build the sections + the named template. No device yet. ──
  const sections = LENGTHS.map((s, i) => section(i, s));
  for (const s of sections) {
    if (s.voices!.drum1.length !== s.steps) throw new Error(`${s.name}: drum grid ${s.voices!.drum1.length} != ${s.steps}`);
    if (s.voices!.synth1.split(' ').length !== s.steps) throw new Error(`${s.name}: synth line != ${s.steps} tokens`);
  }
  console.log('sections:');
  for (const s of sections) console.log(`   ${s.name.padEnd(8)} ${String(s.steps).padStart(2)} steps  drum1 "${s.voices!.drum1.slice(0, 8)}..."  synth1 "${s.voices!.synth1.slice(0, 12)}..."`);

  const tpl = new Uint8Array(readFileSync(TEMPLATE));
  const tplName = nameOf(tpl);
  const want = nameBytes(PROJECT_NAME);
  for (let i = 0; i < NAME_LEN; i++) tpl[NAME_OFF + i] = want[i];
  const namedTemplate = join(ARTIFACTS, 'template-named.ncs');
  writeFileSync(namedTemplate, tpl);
  console.log(`\ntemplate ${TEMPLATE} ("${tplName}") -> ${namedTemplate} ("${nameOf(tpl)}")`);
  console.log('   (naming the TEMPLATE avoids a second write to an occupied slot after authoring)');

  // Timing the test will produce, stated up front so a wrong number is caught here.
  const stepMs = 60_000 / BPM / 4;
  const gaps = LENGTHS.map((s) => (s * stepMs) / 1000);
  let acc = 0;
  const quarters = LENGTHS.map((s) => { const at = acc / 4; acc += s; return at; });
  console.log(`\nexpected at ${BPM} bpm (step ${stepMs} ms): gaps ${gaps.map((g) => g.toFixed(1)).join(' / ')} s, cycle ${(acc * stepMs / 1000).toFixed(1)} s`);
  console.log(`   hits land at quarter ${quarters.map((q) => q.toFixed(1)).join(' / ')} of the cycle -> 3 ON the click, the 4th exactly BETWEEN two clicks`);

  // ── Phase 2: device survey. Refuse on occupied AND on unreadable. ─────
  const conn0 = ensureConnection('circuit');
  const reconnect = (): ReturnType<typeof ensureConnection> => ensureConnection('circuit', true);

  console.log(`\nPack ${devicePack} project directory, read 1 of 2`);
  const dir1 = await readProjectDirectory(conn0, wirePack);
  console.log(`   ${dir1.occupied} of ${dir1.total} occupied${dir1.occupied === 0 ? '   (pack is empty)' : ''}`);
  for (const s of dir1.slots.filter((s) => s.name !== undefined)) console.log(`      project ${String(s.device_slot).padStart(2)}  "${s.name}"`);

  // The device flushes a pack manifest 6-8 s after a session closes, so ONE read
  // is not enough to call a slot free. Poll past the window and require agreement.
  console.log('   waiting 10 s past the manifest-flush window, then re-reading');
  await sleep(10_000);
  const dir2 = await readProjectDirectory(ensureConnection('circuit'), wirePack);
  console.log(`Pack ${devicePack} project directory, read 2 of 2: ${dir2.occupied} of ${dir2.total} occupied`);

  const occ1 = new Map(dir1.slots.filter((s) => s.name !== undefined).map((s) => [s.device_slot, s.name!]));
  const occ2 = new Map(dir2.slots.filter((s) => s.name !== undefined).map((s) => [s.device_slot, s.name!]));
  if (occ1.size !== dir1.occupied || occ2.size !== dir2.occupied) {
    console.log(`REFUSED: a directory read disagrees with itself (${occ1.size}/${dir1.occupied}, ${occ2.size}/${dir2.occupied}). Unreadable is a refusal.`);
    exitMidiScript(1);
  }
  if (occ1.size !== occ2.size || [...occ1.keys()].some((k) => !occ2.has(k))) {
    console.log('REFUSED: the two directory reads disagree. Re-run; do not write on an unstable listing.');
    exitMidiScript(1);
  }
  if (occ1.has(SLOT)) {
    console.log(`REFUSED: Pack ${devicePack} Project ${SLOT} holds "${occ1.get(SLOT)}". This device has no delete; pick an empty slot.`);
    exitMidiScript(1);
  }
  console.log(`   Project ${SLOT} is FREE in both reads`);

  const pool = await readSampleDirectory(ensureConnection('circuit'), wirePack);
  console.log(`\nPack ${devicePack} sample pool: ${pool.occupied} of ${pool.total} occupied`);
  for (const s of pool.slots.filter((s) => s.name !== undefined)) console.log(`      sample ${String(s.device_slot).padStart(2)} (wire ${String(s.slot).padStart(2)})  "${s.name}"`);
  const sidestickHere = pool.slots.find((s) => s.slot === SIDESTICK_WIRE_SLOT)?.name;

  // Pre-write record. The slot is empty so there is nothing to restore, but the
  // pack's state before the write goes on disk regardless.
  const preDump = await downloadProject(ensureConnection('circuit'), SLOT - 1, { pack: wirePack, reconnect });
  const preEmpty = preDump.empty === true;
  if (!preEmpty && preDump.ok && preDump.bytes) {
    const p = join(ARTIFACTS, `pre-write-pack${devicePack}-proj${String(SLOT).padStart(2, '0')}.ncs`);
    writeFileSync(p, preDump.bytes);
    console.log(`REFUSED: Project ${SLOT} returned ${preDump.bytes.length} bytes ("${nameOf(preDump.bytes)}") — it is NOT empty. Saved to ${p}; pick another slot.`);
    exitMidiScript(1);
  }
  console.log(`\npre-write read of Project ${SLOT}: ${preEmpty ? 'EMPTY (no readable project, as expected)' : `ok=${preDump.ok} crcOk=${preDump.crcOk}`}`);

  const record = {
    captured_at: new Date().toISOString(),
    device_pack: devicePack, wire_pack: wirePack, target_project: SLOT,
    project_directory_read_1: snapshot(dir1),
    project_directory_read_2: snapshot(dir2),
    sample_pool: snapshot(pool),
    target_slot_pre_write: preEmpty ? 'empty' : `ok=${preDump.ok} crcOk=${preDump.crcOk}`,
    pack_wide_restore_point: 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z',
  };
  writeFileSync(join(ARTIFACTS, 'pre-write-survey.json'), JSON.stringify(record, null, 2));
  console.log(`pre-write survey -> ${join(ARTIFACTS, 'pre-write-survey.json')}`);

  if (!APPLY) {
    console.log('\n── dry-run author (local template only, no port, no transfer) ──');
    const res = await executeApplyPattern({
      port: 'circuit-tracks', mode: 'ncs_upload', bpm: BPM,
      pack: devicePack, ncs_slot: SLOT, ncs_template: namedTemplate,
      scale: 'chromatic', dry_run: true,
      arrangement: { sections },
    });
    console.log(`   ${res.status} ok=${res.ok}`);
    if (res.info) console.log(`   ${res.info}`);
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    endMidiScript(res.ok ? 0 : 1);
    return;
  }

  // ── Phase 3: the sidestick, so Drum 1 is audible AND sharp ───────────
  if (!NO_SAMPLE) {
    if (sidestickHere !== undefined) {
      console.log(`\nsample slot ${SIDESTICK_WIRE_SLOT + 1} already holds "${sidestickHere}" — leaving it alone (Drum 1 will play it).`);
    } else {
      const wav = new Uint8Array(readFileSync(SIDESTICK_SRC));
      console.log(`\nuploading ${SIDESTICK_SRC} (${wav.length} bytes) -> Pack ${devicePack} sample ${SIDESTICK_WIRE_SLOT + 1} as "${SIDESTICK_FILENAME}"`);
      const up = await uploadSample(ensureConnection('circuit'), wav, SIDESTICK_WIRE_SLOT, SIDESTICK_FILENAME, { packIndex: wirePack, reconnect });
      if (!up.ok) {
        console.log(`   SAMPLE UPLOAD FAILED: ${up.error ?? 'unknown'}`);
        console.log('   Re-run with --no-sample to author the project anyway (Drum 1 will be SILENT and only the read-back half of the test stands).');
        exitMidiScript(1);
      }
      console.log(`   sent ${up.blocks} block(s), converted=${up.converted}. ${up.note}`);
      // The manifest commits 6-8 s AFTER the session closes, so verify by polling.
      let landed = false;
      for (let attempt = 1; attempt <= 3 && !landed; attempt++) {
        reconnect();
        await sleep(attempt === 1 ? 9000 : 5000);
        const p = await readSampleDirectory(ensureConnection('circuit'), wirePack);
        const hit = p.slots.find((s) => s.slot === SIDESTICK_WIRE_SLOT)?.name;
        console.log(`   verify ${attempt}: sample ${SIDESTICK_WIRE_SLOT + 1} = ${hit !== undefined ? `"${hit}"` : '(empty)'}`);
        landed = hit !== undefined;
      }
      if (!landed) {
        console.log('   SAMPLE NOT VISIBLE after polling past the flush window. Stopping before the project write.');
        exitMidiScript(1);
      }
    }
  } else {
    console.log('\n--no-sample: Drum 1 will point at sample slot 1, which is EMPTY on this pack, so it will be SILENT.');
  }

  // ── Phase 4: author ──────────────────────────────────────────────────
  console.log(`\nauthoring Pack ${devicePack} Project ${SLOT}`);
  const res = await executeApplyPattern({
    port: 'circuit-tracks', mode: 'ncs_upload', bpm: BPM,
    pack: devicePack, ncs_slot: SLOT, ncs_template: namedTemplate,
    scale: 'chromatic',
    backup_first: true,
    // confirm_overwrite is DELIBERATELY absent: it is the switch that turns off
    // gateProjectOverwrite's own occupancy check, and there is no delete.
    arrangement: { sections },
  });
  console.log(`   ${res.status} ok=${res.ok}`);
  if (res.warning) console.log(`   warning: ${res.warning}`);
  if (res.info) console.log(`   ${res.info}`);
  if (!res.ok) { console.log('\nFAIL-STOP: the write did not complete.'); exitMidiScript(1); }

  // ── Phase 5: independent read-back. The receipt is not the evidence. ──
  console.log('\nread-back verification (independent download, not the write acknowledgement)');
  await sleep(1500);
  const dl = await downloadProject(ensureConnection('circuit'), SLOT - 1, { pack: wirePack, reconnect });
  if (!dl.ok || !dl.crcOk || dl.bytes === undefined) {
    console.log(`   READ-BACK FAILED (ok=${dl.ok} crcOk=${dl.crcOk} empty=${dl.empty}). Investigate before playing.`);
    exitMidiScript(1);
  }
  const b = dl.bytes;
  const outPath = join(ARTIFACTS, `readback-pack${devicePack}-proj${String(SLOT).padStart(2, '0')}.ncs`);
  writeFileSync(outPath, b);
  console.log(`   ${b.length} bytes, CRC ok, name "${nameOf(b)}"  -> ${outPath}`);

  const fails: string[] = [];
  const check = (ok: boolean, label: string): void => { console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fails.push(label); };

  check(nameOf(b) === PROJECT_NAME, `project name "${nameOf(b)}" == "${PROJECT_NAME}"`);

  const drumLens = LENGTHS.map((_, p) => b[META_OFFSETS[drumBlockIndex(DRUM_TRACK, p)]]);
  const noteLens = LENGTHS.map((_, p) => b[META_OFFSETS[noteBlockIndex(NOTE_TRACK, p)]]);
  check(drumLens.every((v, i) => v === EXPECT_LENGTH_BYTES[i]), `Drum 1 stored length bytes [${drumLens.join(', ')}] == [${EXPECT_LENGTH_BYTES.join(', ')}] (steps-1 of ${LENGTHS.join('/')})`);
  check(noteLens.every((v, i) => v === EXPECT_LENGTH_BYTES[i]), `Synth 1 stored length bytes [${noteLens.join(', ')}] == [${EXPECT_LENGTH_BYTES.join(', ')}]`);

  for (let p = 0; p < LENGTHS.length; p++) {
    const drum = decodeDrumPattern(b, DRUM_TRACK, p);
    const hits = drum.map((s, i) => (s.active ? i : -1)).filter((i) => i >= 0);
    check(hits.length === 1 && hits[0] === 0, `Drum 1 pattern ${p + 1}: hits at step [${hits.join(', ')}] == [0]`);

    const note = decodeNotePattern(b, NOTE_TRACK, p);
    const on = note.map((s, i) => (s.notes.length > 0 ? i : -1)).filter((i) => i >= 0);
    const pitches = note.flatMap((s) => s.notes.map((n) => n.note));
    check(on.length === 1 && on[0] === 0 && pitches.length === 1 && pitches[0] === SYNTH_NOTE_MIDI,
      `Synth 1 pattern ${p + 1}: notes at step [${on.join(', ')}] == [0], pitch [${pitches.join(', ')}] == [${SYNTH_NOTE_MIDI}]`);
  }

  const nchain = getNoteChain(b, NOTE_TRACK);
  check(b[CHAIN_SYNTH1] === 0 && b[CHAIN_SYNTH1 + 1] === 3,
    `Synth 1 chain bytes 0x2c4/0x2c5 = [${b[CHAIN_SYNTH1]}, ${b[CHAIN_SYNTH1 + 1]}] == [0, 3]  (decoder says ${nchain ? `[${nchain.start}, ${nchain.end}]` : 'unchained'})`);
  check(b[CHAIN_DRUM1] === 0 && b[CHAIN_DRUM1 + 1] === 3,
    `Drum 1 chain bytes 0x2d4/0x2d5 = [${b[CHAIN_DRUM1]}, ${b[CHAIN_DRUM1 + 1]}] == [0, 3]`);

  const binding = [...b.slice(DRUM_BINDING_OFFSET, DRUM_BINDING_OFFSET + 4)];
  check(binding[0] === SIDESTICK_WIRE_SLOT, `Drum 1 sample binding = ${binding[0]} (pack sample ${binding[0] + 1}); full binding [${binding.join(', ')}]`);
  check(b[SCALE_TYPE_OFFSET] === SCALE_CHROMATIC, `project scale byte ${b[SCALE_TYPE_OFFSET]} == ${SCALE_CHROMATIC} (Chromatic, so c4 plays as c4)`);

  console.log(fails.length === 0
    ? `\nREAD-BACK VERDICT: PASS. Pack ${devicePack} Project ${SLOT} holds the mixed-length chain exactly as authored.`
    : `\nREAD-BACK VERDICT: FAIL on ${fails.length} check(s). Do not draw a conclusion from the listening test until these are explained.`);
  endMidiScript(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
