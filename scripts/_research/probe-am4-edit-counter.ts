/**
 * AM4 GET_PATCH "edit counter" probe — READ-ONLY.
 * ===============================================
 *
 * Question: does AM4's GET_PATCH (action 0x1F) ~192-byte metadata descriptor
 * carry a field that reflects "the working buffer was edited" — i.e. a
 * device-true equivalent of the front-panel EDIT light? The Ghidra notes
 * (am4edit-action-table.md) found GET_PATCH responses are near-identical
 * except a 16-bit counter around bytes 12-13. If that field increments on a
 * front-panel edit and stays put otherwise, it's the reliable, deterministic
 * dirty signal we want (better than markDirty, which can't see front-panel
 * edits, and better than the non-deterministic 12 KB dump).
 *
 * This script only SENDS GET_PATCH reads — no writes, no saves, no stores.
 * It polls the descriptor every ~1.5 s and prints, per read, which response
 * bytes changed since the previous read. Watch the diff while you do the
 * sequence below.
 *
 * A prior run showed byte[21] holds 0x00 at rest and flips to 0x04 when you
 * edit — candidate "buffer edited" bit. This run CONFIRMS it. Bytes
 * 29/30/31/236 are free-running noise (they change every read regardless of
 * edits); this script ignores them and spotlights byte[21].
 *
 * RUN IT, then on the AM4 do each step and HOLD STILL for ~3 reads each:
 *   reads 0-2 : DO NOTHING                 → byte[21] should hold (baseline)
 *   reads 3-5 : turn ONE knob (a single    → does byte[21] become 0x04 (edited)?
 *               edit), then STOP
 *   reads 6-8 : DO NOTHING                 → does byte[21] HOLD at 0x04?
 *   reads 9-11: SAVE the preset on-device  → does byte[21] return to 0x00 (clean)?
 *   reads 12+ : DO NOTHING                 → does it HOLD at 0x00?
 *
 * If byte[21] = 0x04 after an edit and = 0x00 after a save (and holds in
 * between), it's the device-true dirty bit and we wire the AM4 gate to read it.
 *
 * Run:  npx tsx scripts/_research/probe-am4-edit-counter.ts
 */

import midi from "@julusian/midi";

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;
const GET_PATCH_ACTION = 0x1f;

const READS = 24;
const INTERVAL_MS = 1500;
const RESPONSE_WAIT_MS = 400;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}
function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}
function buildActionFrame(pidLow: number, pidHigh: number, action: number): number[] {
  const head = [
    SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FUNC_PARAM_RW,
    ...encode14(pidLow), ...encode14(pidHigh), ...encode14(action),
    ...encode14(0x0000), ...encode14(0x0000), // hdr3 + payload-length 0
  ];
  return [...head, fractalChecksum(head), SYSEX_END];
}
function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i).toLowerCase();
    if (needles.some((n) => name.includes(n))) return i;
  }
  return -1;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();
  const inPort = findPort(input, ['am4', 'fractal']);
  const outPort = findPort(output, ['am4', 'fractal']);
  if (inPort < 0 || outPort < 0) {
    console.error('AM4 not found on MIDI ports. Is it connected + powered?');
    process.exit(1);
  }
  console.log(`  in  [${inPort}] ${input.getPortName(inPort)}`);
  console.log(`  out [${outPort}] ${output.getPortName(outPort)}`);
  input.openPort(inPort);
  output.openPort(outPort);
  input.ignoreTypes(false, true, true); // keep SysEx

  let frames: number[][] = [];
  input.on('message', (_dt, msg) => { if (msg[0] === SYSEX_START) frames.push([...msg]); });

  console.log('\nPolling GET_PATCH every 1.5s. Follow the sequence in the file header.\n');
  let last: number[] | undefined;
  for (let i = 0; i < READS; i++) {
    frames = [];
    output.sendMessage(buildActionFrame(0, 0, GET_PATCH_ACTION));
    await sleep(RESPONSE_WAIT_MS);
    // The descriptor is the largest inbound SysEx frame for this read.
    const resp = frames.slice().sort((a, b) => b.length - a.length)[0];
    if (!resp) {
      console.log(`#${String(i).padStart(2)}  (no response)`);
    } else if (!last) {
      console.log(`#${String(i).padStart(2)}  BASELINE  byte[21]=0x${(resp[21] ?? 0).toString(16).padStart(2, '0')}  len=${resp.length}  full: ${toHex(resp)}`);
    } else {
      const NOISE = new Set([29, 30, 31, 236]); // free-running every read, not edit-related
      const b21 = resp[21] ?? 0;
      const flag = b21 === 0x04 ? 'EDITED? (0x04)' : b21 === 0x00 ? 'clean?  (0x00)' : `0x${b21.toString(16).padStart(2, '0')}`;
      const n = Math.max(resp.length, last.length);
      const changed: string[] = [];
      for (let b = 0; b < n; b++) {
        if (resp[b] !== last[b] && !NOISE.has(b)) changed.push(`[${b}]${(last[b] ?? 0).toString(16)}->${(resp[b] ?? 0).toString(16)}`);
      }
      console.log(
        `#${String(i).padStart(2)}  byte[21]=${flag}  ` +
        (changed.length ? `(other non-noise changes: ${changed.join(' ')})` : '(no other change)'),
      );
    }
    if (resp) last = resp;
    await sleep(Math.max(0, INTERVAL_MS - RESPONSE_WAIT_MS));
  }
  input.closePort();
  output.closePort();
  console.log('\nDone. If specific byte(s) flip on edits and stay stable on no-edit, that is the dirty field.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(99); });
