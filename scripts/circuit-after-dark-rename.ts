/**
 * circuit-after-dark-rename.ts: give the two After Dark projects real names.
 *
 * `apply_pattern mode:ncs_upload` templates from `blank_slot20.ncs`, which
 * carries the name "User Session" at 0x10, so both authored projects landed with
 * that name. Two identically-named projects in a pack is a live-performance
 * problem: he cannot tell them apart in Projects view.
 *
 * The name field is bytes 0x10..0x30, 32 bytes of space-padded ASCII (verified
 * against ClintEastwood P8, Sugar 1/10 and the template itself). This patches
 * exactly those 32 bytes and nothing else.
 *
 * Byte-surgical rather than a re-author, deliberately: the projects are already
 * authored and READ-BACK VERIFIED, and re-running the authoring path over an
 * occupied slot would need `confirm_overwrite`, which is the switch that turns
 * off the writer's own occupancy gate. There is no delete on this device, so the
 * gate stays on and only the name bytes move.
 *
 * SAFETY: dry run by default, `--apply` required. CRC-gated read, timestamped
 * backup that refuses to overwrite, name assertion before patching (refuses
 * anything that is not the expected template name), read-back verify against an
 * exact expected-byte-set with ZERO collateral tolerated, fail-stop.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-rename.ts            # dry run
 *   npx tsx scripts/circuit-after-dark-rename.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '2');

const NAME_OFF = 0x10;
const NAME_LEN = 0x20;                 // 32 bytes, space-padded
const EXPECT_CURRENT = 'User Session'; // what the template leaves behind
const TARGETS: { slot: number; name: string }[] = [
  { slot: Number(flag('--slot1') ?? '1'), name: 'AfterDark P1' },
  { slot: Number(flag('--slot2') ?? '2'), name: 'AfterDark P2' },
];

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** The exact 32 bytes a name becomes. Refuses anything that will not fit or is not printable ASCII. */
function nameBytes(name: string): number[] {
  if (name.length > NAME_LEN) throw new Error(`name "${name}" is ${name.length} chars; the field holds ${NAME_LEN}`);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`name "${name}" has non-printable-ASCII characters`);
  return Array.from({ length: NAME_LEN }, (_, i) => (i < name.length ? name.charCodeAt(i) : 0x20));
}

async function main(): Promise<void> {
  console.log(`Rename After Dark projects on Pack ${devicePack}`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log('');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `samples/circuit-ncs/restore-afterdark-rename-${stamp}`;
  if (APPLY) mkdirSync(backupDir, { recursive: true });

  let conn = connect(CONNECT);
  const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let done = 0;

  for (const t of TARGETS) {
    const tag = `project ${String(t.slot).padStart(2)}`;
    const r = await downloadProject(conn, t.slot - 1, { pack: devicePack - 1, reconnect });
    if (!r.ok || !r.crcOk || r.bytes === undefined) {
      console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
      exitMidiScript(1);
    }
    const b = r.bytes;
    const cur = nameOf(b);
    if (cur !== EXPECT_CURRENT) {
      console.log(`  ${tag}  REFUSED: name is "${cur}", expected "${EXPECT_CURRENT}". Not touching a project this script did not author.`);
      continue;
    }
    const want = nameBytes(t.name);
    const edits: { off: number; to: number }[] = [];
    for (let i = 0; i < NAME_LEN; i++) if (b[NAME_OFF + i] !== want[i]) edits.push({ off: NAME_OFF + i, to: want[i] });
    if (edits.length === 0) { console.log(`  ${tag}  already "${t.name}"`); continue; }

    if (!APPLY) { console.log(`  ${tag}  "${cur}" -> "${t.name}"  (${edits.length} byte(s))`); continue; }

    const backup = `${backupDir}/pack${devicePack}-proj${String(t.slot).padStart(2, '0')}.ncs`;
    if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); exitMidiScript(1); }
    writeFileSync(backup, b);

    const out = Buffer.from(b);
    for (const e of edits) out[e.off] = e.to;

    const up = await uploadProject(conn, out, t.slot - 1, { pack: devicePack - 1, reconnect });
    if (!up.ok) {
      console.log(`  ${tag}  UPLOAD FAILED: ${up.error ?? 'unknown'} (original at ${backup})`);
      exitMidiScript(1);
    }
    const v = await downloadProject(conn, t.slot - 1, { pack: devicePack - 1, reconnect });
    if (!v.ok || !v.crcOk || v.bytes === undefined) {
      console.log(`  ${tag}  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
      exitMidiScript(1);
    }
    const intended = new Map(edits.map((e) => [e.off, e.to]));
    const wrong: string[] = [];
    let collateral = 0;
    for (let i = 0; i < b.length; i++) {
      const w = intended.get(i);
      if (w !== undefined) { if (v.bytes[i] !== w) wrong.push(`0x${i.toString(16)}=${v.bytes[i]} (wanted ${w})`); }
      else if (v.bytes[i] !== b[i]) collateral++;
    }
    if (wrong.length > 0 || collateral !== 0) {
      console.log(`  ${tag}  VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral=${collateral}`);
      console.log(`             restore with ${backup}`);
      exitMidiScript(1);
    }
    console.log(`  ${tag}  "${cur}" -> "${nameOf(v.bytes)}"  ${edits.length} byte(s), verified, ZERO collateral`);
    done++;
    await sleep(400);
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${done} renamed.`);
  if (APPLY && done > 0) console.log(`restore points: ${backupDir}`);
  endMidiScript();
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
