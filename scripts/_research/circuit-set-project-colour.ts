/**
 * circuit-set-project-colour.ts — HARDWARE TEST of the project-colour decode,
 * in the WRITE direction.
 *
 * THE CLAIM UNDER TEST (docs/_private/circuit-project-colour-decode-2026-07-29.md):
 * a project's Projects-View pad colour is a palette index 0..13 stored as an
 * LE uint32 at file offset 0x0C. The decode doc proposed a READ-direction test
 * (re-Save on the device with a chosen colour, download, diff). This tests the
 * direction we actually want to USE: write the byte in the file, upload, and
 * see whether the device renders the new colour.
 *
 * WHY WRITE-DIRECTION IS THE STRONGER TEST. A read-direction pass would only
 * show that the device SERIALISES colour there. It would not show that the
 * device DESERIALISES it — i.e. that a file-authored colour is honoured. Only
 * the write direction supports "stamp colour at authoring time".
 *
 * WHAT A NULL RESULT MEANS. If the pads do not change, either (a) 0x0C is read
 * at project-LOAD time only (so the pad grid keeps a cached colour until the
 * project is loaded), or (b) the colour lives in DEVICE-SIDE metadata (the pack
 * directory entry) rather than in the .ncs, in which case a file write can never
 * move it. Writing two DISTINCT non-default colours to two adjacent slots
 * separates "nothing happened" from "one thing happened": a partial result is
 * visible as one pad moving and not the other.
 *
 * SAFETY (identical contract to circuit-set-project-tempo.ts): dry run by
 * default, `--apply` required, CRC-gated read, timestamped backup that refuses
 * to overwrite, expected-name assertion, post-flush-window read-back verify with
 * ZERO collateral bytes tolerated.
 *
 * The device said yes (2026-07-29), so the offset and palette have been PROMOTED
 * to `packages/circuit-tracks/src/ncs/format.ts` and this script now imports
 * them. It deliberately keeps no local copy: the thing this script verifies on
 * hardware has to be the same code the authoring path ships, or a later drift
 * between the two would go unnoticed by exactly the test meant to catch it.
 *
 * Usage:
 *   npx tsx scripts/_research/circuit-set-project-colour.ts --pack 3 --slot 1 --name "MetreTest A" --colour 0
 *   npx tsx scripts/_research/circuit-set-project-colour.ts --pack 3 --slot 1 --name "MetreTest A" --colour 0 --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect, closeAllMidiConnections } from '../../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from '../_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  PROJECT_COLOUR_OFFSET, PROJECT_COLOURS, getProjectTempo, setProjectColour,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '3');
const slot = Number(flag('--slot') ?? '1');
const colour = Number(flag('--colour'));
const expectName = flag('--name');

const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();
const hex = (b: Uint8Array, from: number, len: number): string =>
  Array.from(b.slice(from, from + len)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The device takes ~6-8s to flush its manifest to flash after a transfer closes.
 * A read-back inside that window can answer from a stale cache, so the verify
 * waits past it — the whole point of an INDEPENDENT read-back.
 */
const FLUSH_WINDOW_MS = 9000;

async function main(): Promise<void> {
  if (!Number.isInteger(colour) || colour < 0 || colour >= PROJECT_COLOURS.length) {
    console.error(`--colour must be a palette index 0..${PROJECT_COLOURS.length - 1} (${PROJECT_COLOURS.join('/')}), got ${flag('--colour') ?? '(missing)'}`);
    process.exit(1);
  }
  if (!expectName) { console.error('--name is required (the project name this must match before it is touched)'); process.exit(1); }

  console.log(`Set colour on Pack ${devicePack} project ${slot} -> ${colour} (${PROJECT_COLOURS[colour]})`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log('');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `samples/circuit-ncs/restore-colour-${stamp}`;
  if (APPLY) mkdirSync(backupDir, { recursive: true });

  let conn = connect(CONNECT);
  const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };

  const r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  READ FAILED (ok=${r.ok} crcOk=${r.crcOk} empty=${r.empty ?? false}) ${r.error ?? ''}`);
    exitMidiScript(1);
  }
  const b = r.bytes;
  const cur = nameOf(b);
  const curColour = b[PROJECT_COLOUR_OFFSET];
  console.log(`  project name   : "${cur}"`);
  console.log(`  stored tempo   : ${getProjectTempo(b)} BPM (untouched by this script)`);
  console.log(`  header 0x00-0x0f: ${hex(b, 0, 16)}`);
  console.log(`  colour @0x0c   : ${curColour} (${PROJECT_COLOURS[curColour] ?? 'OUT OF RANGE'})`);
  console.log(`  high bytes 0x0d-0x0f: ${hex(b, 0x0d, 3)}  (must be 00 00 00 for a single-byte write)`);
  if (cur !== expectName) {
    console.log(`  REFUSED: name is "${cur}", expected "${expectName}". Not touching a project this invocation did not name.`);
    exitMidiScript(1);
  }
  if (b[0x0d] !== 0 || b[0x0e] !== 0 || b[0x0f] !== 0) {
    console.log('  REFUSED: 0x0d-0x0f are not zero, so 0x0C is not a small LE uint32 here. Decode assumption broken; stopping.');
    exitMidiScript(1);
  }
  if (curColour === colour) { console.log(`  already colour ${colour}; nothing to do.`); endMidiScript(); return; }

  if (!APPLY) {
    console.log(`  would change 1 byte: 0x${PROJECT_COLOUR_OFFSET.toString(16)} ${curColour} -> ${colour}`);
    endMidiScript(); return;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  refusing to overwrite existing backup ${backup}`); exitMidiScript(1); }
  writeFileSync(backup, b);
  console.log(`  backup         : ${backup}`);

  const out = new Uint8Array(b);
  setProjectColour(out, colour);

  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) { console.log(`  UPLOAD FAILED: ${up.error ?? 'unknown'} (original at ${backup})`); exitMidiScript(1); }
  console.log(`  upload ok (${up.blocks} data blocks)`);

  // INDEPENDENT read-back: past the flash-flush window, on a FRESH handle, so
  // the verify cannot be answered out of an in-flight write cache.
  console.log(`  waiting ${FLUSH_WINDOW_MS} ms past the flash-flush window before verify...`);
  await sleep(FLUSH_WINDOW_MS);
  conn = reconnect();

  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    exitMidiScript(1);
  }
  let collateral = 0;
  const collateralAt: string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i === PROJECT_COLOUR_OFFSET) continue;
    if (v.bytes[i] !== b[i]) { collateral++; if (collateralAt.length < 8) collateralAt.push(`0x${i.toString(16)}=${v.bytes[i]} (was ${b[i]})`); }
  }
  const landed = v.bytes[PROJECT_COLOUR_OFFSET];
  console.log('');
  console.log(`  read-back header 0x00-0x0f: ${hex(v.bytes, 0, 16)}`);
  console.log(`  read-back colour : ${landed} (${PROJECT_COLOURS[landed] ?? '?'}) ${landed === colour ? 'OK' : 'WRONG'} (was ${curColour})`);
  console.log(`  collateral bytes : ${collateral}${collateralAt.length > 0 ? ` [${collateralAt.join(', ')}]` : ''}`);
  if (landed !== colour || collateral !== 0) {
    console.log(`  VERIFY FAILED. Restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`  OK: 1 byte of ${b.length} changed, colour ${curColour} (${PROJECT_COLOURS[curColour]}) -> ${landed} (${PROJECT_COLOURS[landed]}), CRC verified both directions.`);
  endMidiScript();
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exit(1); });
