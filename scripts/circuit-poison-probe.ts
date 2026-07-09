/**
 * @julusian/midi POISON PROBE (interactive, owns its own connection).
 *
 * Characterizes what a SEND does on a handle whose device went away mid-session
 * — the unknown that the whole connection-canary plan rests on. We need to know
 * if a send on a stale handle: THROWS (sets lastSendError → our guards work),
 * BLOCKS forever (freezes the thread → guards are blind, the dangerous case), or
 * SILENTLY SUCCEEDS (returns ok, nothing lands → guards blind, need another
 * signal). Also: does isPortOpen() flip to false after an unplug?
 *
 * SAFE: the only thing sent is a SINGLE benign CC (ch16 reverb-send = 0). NO
 * file-transfer, NO session frames — a CC cannot strand a session or write
 * flash, so it cannot reboot the device. Run in YOUR OWN terminal (it pauses
 * for Enter at each step so you can watch the device):
 *
 *   npx tsx scripts/circuit-poison-probe.ts
 *
 * If the script HANGS after you unplug (no "STALE-1" line within ~10 s), THAT
 * IS the blocked-send finding — Ctrl-C it and report "it hung at STALE".
 */

import readline from 'node:readline';
import { connect, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

// Benign: ch16 (0xB0|15 = 0xBF) CC 90 (drum1 reverb send) = 0. No transfer, no session.
const BENIGN = [0xbf, 90, 0];

function timedSend(conn: MidiConnection, label: string): void {
  const open0 = conn.isPortOpen ? conn.isPortOpen() : 'n/a';
  const t0 = Date.now();
  let threw: string | undefined;
  try {
    conn.send(BENIGN);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const dt = Date.now() - t0;
  const lse = conn.lastSendError?.message;
  console.log(
    `  [${label}] send took ${dt} ms | threw: ${threw ?? 'no'} | ` +
    `isPortOpen(before): ${open0} | lastSendError: ${lse ?? 'none'}`,
  );
}

async function main(): Promise<void> {
  console.log('\n=== Circuit @julusian POISON PROBE ===');
  console.log('(single benign CC per step — no transfer, no session, cannot reboot the device)\n');

  await ask('STEP 1 — PLUG IN the Circuit USB (powered + connected), then press Enter... ');
  let conn: MidiConnection;
  try {
    conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
  } catch (e) {
    console.log('\nCONNECT FAILED: ' + (e instanceof Error ? e.message : String(e)));
    console.log('If it says the port is in use, the MCP server is still holding it (a zombie-handle');
    console.log('finding in itself) — fully quit the host app and rerun. Otherwise replug and rerun.\n');
    rl.close();
    return;
  }
  console.log('  connected. isPortOpen = ' + (conn.isPortOpen ? conn.isPortOpen() : 'n/a'));
  console.log('  -- baseline send on a LIVE handle (expect: fast, no throw) --');
  timedSend(conn, 'ALIVE');

  await ask('\nSTEP 2 — UNPLUG the Circuit USB now (leave it POWERED, just pull the cable), then press Enter... ');
  console.log('  -- THE KEY MEASUREMENT: send on the now-STALE handle --');
  console.log('     (if the next line does not appear within ~10 s, the send is BLOCKED — Ctrl-C and report "hung at STALE")');
  timedSend(conn, 'STALE-1');
  timedSend(conn, 'STALE-2');
  console.log('  isPortOpen() after unplug = ' + (conn.isPortOpen ? conn.isPortOpen() : 'n/a'));

  await ask('\nSTEP 3 — REPLUG the Circuit USB, then press Enter... ');
  console.log('  -- send on the SAME (old) handle after replug (does it self-recover, or stay dead?) --');
  timedSend(conn, 'REPLUGGED-SAME-HANDLE');

  try { conn.close(); } catch { /* best-effort */ }
  console.log('\n=== DONE — copy this whole output back to the chat. ===\n');
  rl.close();
}

main().catch((e) => { console.error('PROBE ERROR:', e); rl.close(); });
