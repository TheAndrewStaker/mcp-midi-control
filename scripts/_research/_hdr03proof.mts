/**
 * READ-ONLY PROOF. Hypothesis: every frame in the patchbank `frames.jsonl` plans is ONE BYTE SHORT —
 * the generator (`scripts/_research/patchbank-frames.py`) builds its envelope from a 5-byte
 * `XHDR = [00 20 29 01 64]`, but the Circuit Tracks file-transfer header is SIX bytes,
 * `00 20 29 01 64 03` (`packages/circuit-tracks/src/ncs/transfer.ts:22`). So the runner replays
 * frames addressed to a command group that does not exist, the device ignores every one of them,
 * and `conn.onMessage` correctly reports zero inbound messages — the device really is silent.
 *
 * A: replay the frame plan's own prelude + QUERY_EXISTS bytes VERBATIM -> expect 0 replies.
 * B: replay the SAME frames with 0x03 spliced back in at index 6 -> expect real replies.
 *
 * Sends ONLY close/open/dir/query frames. Never WRITE_INIT (0x01), WRITE_DATA (0x02),
 * WRITE_FINISH (0x03) or DELETE_FILE (0x08).
 */
import { readFileSync } from 'node:fs';

import { connect } from '../../packages/core/src/midi/transport.js';
import { endMidiScript } from '../_lib/midi-lifecycle.js';

const PLAN = 'C:/dev/mcp-midi-tools/samples/circuit-tracks/patchbank-wire3-2026-09-20/frames.jsonl';
const READ_ONLY_LABELS = /^(close_session|open_session|dir_control_1|query_info|dir_control_2|dir_scope_patch|query_exists g0)/;

interface PlanFrame { label: string; hex: string }
const plan: PlanFrame[] = readFileSync(PLAN, 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as PlanFrame)
  .filter((f) => READ_ONLY_LABELS.test(f.label));

const hexBytes = (hex: string): number[] => hex.match(/../g)!.map((h) => parseInt(h, 16));
const hx = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Splice the missing file-command-group byte back in: F0 00 20 29 01 64 | 03 | <sub> … F7 */
const withGroupByte = (b: number[]): number[] => [...b.slice(0, 6), 0x03, ...b.slice(6)];

// HARD SAFETY: after the group byte is restored, index 7 is the subcommand. Refuse to send any
// frame whose subcommand is a write or a delete, whichever variant we are replaying.
const FORBIDDEN = new Set([0x01, 0x02, 0x03, 0x07, 0x08]);
function assertReadOnly(fixed: number[], label: string): void {
  if (FORBIDDEN.has(fixed[7])) throw new Error(`REFUSING to send a write/delete frame: ${label} sub=0x${fixed[7].toString(16)}`);
}

const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' });
const seen: number[][] = [];
conn.onMessage((m) => { seen.push(m); });
const drain = (): number[][] => seen.splice(0);

async function run(label: string, fix: boolean): Promise<void> {
  console.log(`\n=== ${label}`);
  let total = 0;
  for (const f of plan) {
    const raw = hexBytes(f.hex);
    const fixed = withGroupByte(raw);
    const bytes = fix ? fixed : raw;
    assertReadOnly(bytes[6] === 0x03 ? bytes : fixed, f.label);
    if (f.label.startsWith('query_exists')) {
      drain();
      conn.send(bytes);
      await sleep(1500);
      const replies = drain();
      console.log(`  ${f.label.padEnd(26)} [${hx(bytes)}] -> ${replies.length} reply(ies)`);
      for (const r of replies.slice(0, 2)) console.log(`       ${hx(r)}`);
      total += replies.length;
    } else {
      conn.send(bytes);
      await sleep(f.label === 'open_session' ? 300 : f.label.startsWith('dir_scope') ? 500 : 200);
      const replies = drain();
      console.log(`  ${f.label.padEnd(26)} [${hx(bytes.slice(0, 12))}${bytes.length > 12 ? ' …' : ''}] -> ${replies.length} reply(ies)`);
      total += replies.length;
    }
  }
  console.log(`  TOTAL inbound messages for this pass: ${total}`);
  conn.send(fix ? withGroupByte(hexBytes('f0002029016441f7')) : hexBytes('f0002029016441f7'));
  await sleep(300); drain();
}

const alreadyFixed = hexBytes(plan[0].hex)[6] === 0x03;
if (alreadyFixed) {
  // Post-fix re-run: the plan on disk already carries the group byte, so VERBATIM is the fixed form.
  await run('POST-FIX: regenerated frames.jsonl bytes VERBATIM (6-byte header)', false);
} else {
  await run('A: frames.jsonl bytes VERBATIM (5-byte header, no 0x03 group byte)', false);
  await sleep(800);
  await run('B: same frames with 0x03 spliced in at index 6 (6-byte header)', true);
}

endMidiScript(0);
