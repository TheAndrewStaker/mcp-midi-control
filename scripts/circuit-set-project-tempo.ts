/**
 * circuit-set-project-tempo.ts: set a stored project's tempo, surgically.
 *
 * WHY THIS EXISTS. The `.ncs` authoring path never wrote the tempo byte, so
 * every project it produced inherited the TEMPLATE's tempo (120) rather than the
 * song's. `apply_pattern mode:ncs_upload` now writes it, but that only helps
 * projects authored from here on: anything already on the device needs the byte
 * corrected in place, and re-authoring an occupied slot would need
 * `confirm_overwrite`, the one switch we do not pass on a device with no erase.
 * So this does what the rename script does — download, patch the single byte,
 * upload to the SAME slot, verify with ZERO collateral tolerated.
 *
 * Tempo is one plain byte at 0x34 (see `ncs/format.ts` for the encoding
 * evidence: the byte IS the BPM, range 40..240). Swing is the adjacent byte and
 * is REPORTED but never written — it is a feel setting the maintainer may have
 * dialled by hand, and nothing here has any business guessing at it.
 *
 * SAFETY: dry run by default, `--apply` required. CRC-gated read, timestamped
 * backup that refuses to overwrite an existing one, an expected-name assertion
 * (refuses a project this invocation did not name), read-back verify against an
 * exact expected-byte-set, fail-stop on any collateral byte.
 *
 * Usage:
 *   npx tsx scripts/circuit-set-project-tempo.ts --pack 3 --slot 1 --name "MetreTest A" --bpm 60
 *   npx tsx scripts/circuit-set-project-tempo.ts --pack 3 --slot 1 --name "MetreTest A" --bpm 60 --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  PROJECT_TEMPO_OFFSET, PROJECT_SWING_OFFSET, TEMPO_MIN_BPM, TEMPO_MAX_BPM,
  getProjectTempo, getProjectSwing, setProjectTempo,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '1');
const slot = Number(flag('--slot') ?? '1');
const bpm = Number(flag('--bpm'));
const expectName = flag('--name');

const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

async function main(): Promise<void> {
  if (!Number.isInteger(bpm) || bpm < TEMPO_MIN_BPM || bpm > TEMPO_MAX_BPM) {
    console.error(`--bpm must be a whole number in ${TEMPO_MIN_BPM}..${TEMPO_MAX_BPM}, got ${flag('--bpm') ?? '(missing)'}`);
    process.exit(1);
  }
  if (!expectName) { console.error('--name is required (the project name this must match before it is touched)'); process.exit(1); }

  console.log(`Set tempo on Pack ${devicePack} project ${slot} -> ${bpm} BPM`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log('');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `samples/circuit-ncs/restore-tempo-${stamp}`;
  if (APPLY) mkdirSync(backupDir, { recursive: true });

  let conn = connect(CONNECT);
  const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };

  const r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    exitMidiScript(1);
  }
  const b = r.bytes;
  const cur = nameOf(b);
  console.log(`  project name : "${cur}"`);
  console.log(`  stored tempo : ${getProjectTempo(b)} BPM`);
  console.log(`  stored swing : ${getProjectSwing(b)} (50 = even, untouched by this script)`);
  if (cur !== expectName) {
    console.log(`  REFUSED: name is "${cur}", expected "${expectName}". Not touching a project this invocation did not name.`);
    exitMidiScript(1);
  }
  if (getProjectTempo(b) === bpm) { console.log(`  already ${bpm} BPM; nothing to do.`); endMidiScript(); return; }

  if (!APPLY) {
    console.log(`  would change 1 byte: 0x${PROJECT_TEMPO_OFFSET.toString(16)} ${getProjectTempo(b)} -> ${bpm}`);
    endMidiScript(); return;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  refusing to overwrite existing backup ${backup}`); exitMidiScript(1); }
  writeFileSync(backup, b);
  console.log(`  backup       : ${backup}`);

  const out = new Uint8Array(b);
  const prev = setProjectTempo(out, bpm);

  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) { console.log(`  UPLOAD FAILED: ${up.error ?? 'unknown'} (original at ${backup})`); exitMidiScript(1); }

  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    exitMidiScript(1);
  }
  // Exactly one byte may differ from what we read, and it must be the tempo.
  let collateral = 0;
  const collateralAt: string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i === PROJECT_TEMPO_OFFSET) continue;
    if (v.bytes[i] !== b[i]) { collateral++; if (collateralAt.length < 6) collateralAt.push(`0x${i.toString(16)}=${v.bytes[i]} (was ${b[i]})`); }
  }
  const landed = getProjectTempo(v.bytes);
  console.log('');
  console.log(`  read-back tempo : ${landed} BPM ${landed === bpm ? 'OK' : 'WRONG'} (was ${prev})`);
  console.log(`  read-back swing : ${getProjectSwing(v.bytes)}`);
  console.log(`  collateral bytes: ${collateral}${collateralAt.length > 0 ? ` [${collateralAt.join(', ')}]` : ''}`);
  if (landed !== bpm || collateral !== 0) {
    console.log(`  VERIFY FAILED. Restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`  OK: 1 byte of ${b.length} changed, tempo ${prev} -> ${landed} BPM, CRC verified both directions.`);
  endMidiScript();
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exit(1); });
