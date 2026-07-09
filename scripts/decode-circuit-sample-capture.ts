/**
 * Decode a captured Novation Components SAMPLE upload to recover the two
 * Circuit-Tracks-specific unknowns blocking automated sample upload:
 *   (1) the sample FILE-TYPE byte (projects use 0x03), and
 *   (2) the audio PAYLOAD format (header? raw PCM? bit depth / rate / channels).
 *
 * Feed it a binary file of the captured SysEx — concatenated F0..F7 messages.
 * Produce that from your capture however is easiest:
 *   - USBPcap + Wireshark: filter the device's USB MIDI OUT, "Follow / Export"
 *     the bulk MIDI bytes to a .bin, OR
 *   - a SysEx monitor log saved as raw bytes.
 * The decoder scans for F0..F7 anywhere in the bytes, so extra framing is fine.
 *
 * It reuses our PROVEN project file-transfer decode (transfer.ts) so it can tell
 * us exactly how the SAMPLE transfer differs from the (known) PROJECT transfer.
 *
 * Run:  npx tsx scripts/decode-circuit-sample-capture.ts <capture.bin>
 */

import { readFileSync } from 'node:fs';
import { TRANSFER_CONSTANTS, msbDeinterleave } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER; // [0x00,0x20,0x29,0x01,0x64,0x03] (Novation + Circuit Tracks + file-cmd-group)
const PROJECT_FILE_TYPE = TRANSFER_CONSTANTS.FILE_TYPE_PROJECT; // 0x03

const SUB_NAME: Record<number, string> = Object.fromEntries(Object.entries(SUB).map(([k, v]) => [v, k]));
const hex = (b: number) => '0x' + b.toString(16).padStart(2, '0');
const hexRun = (a: readonly number[]) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');

function splitSysEx(bytes: Uint8Array): number[][] {
  const out: number[][] = [];
  let cur: number[] | undefined;
  for (const b of bytes) {
    if (b === 0xf0) cur = [0xf0];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { out.push(cur); cur = undefined; }
    }
  }
  return out;
}

const path = process.argv[2];
if (!path) { console.error('usage: decode-circuit-sample-capture.ts <capture.bin>'); process.exit(2); }

const bytes = new Uint8Array(readFileSync(path));
const msgs = splitSysEx(bytes);
console.log(`Read ${bytes.length} bytes, found ${msgs.length} SysEx message(s).\n`);

const headerMatch = (m: number[]) => HDR.every((h, i) => m[1 + i] === h);
let dataBytesTotal = 0;
let firstPayloadHead: number[] | undefined;
const fileTypesSeen = new Set<number>();
let nonProjectCmdGroup = false;

for (const m of msgs) {
  const novation = m[1] === 0x00 && m[2] === 0x20 && m[3] === 0x29;
  if (!novation) { console.log(`  (skip non-Novation: ${hexRun(m.slice(0, 6))} …)`); continue; }
  const product = `${hex(m[4])} ${hex(m[5])}`;          // 01 64 = Circuit Tracks
  const cmdGroup = m[6];                                 // 0x03 = file ops on projects
  const subcmd = m[7];
  if (cmdGroup !== HDR[5]) nonProjectCmdGroup = true;
  // The body after F0+HEADER(6)+subcmd is: [addr(8)][fileId(3)][...]
  const body = m.slice(1 + HDR.length + 1, m.length - 1);
  const label = SUB_NAME[subcmd] ?? `sub ${hex(subcmd)}`;
  console.log(`MSG product=${product} cmdGroup=${hex(cmdGroup)} ${label} (len ${m.length})`);

  if (subcmd === SUB.WRITE_INIT || subcmd === SUB.WRITE_DATA) {
    const fileType = body[8];                            // fileId[0] — THE KEY UNKNOWN
    fileTypesSeen.add(fileType);
    const isPcm = subcmd === SUB.WRITE_DATA;
    const interleaved = body.slice(11);                  // after addr(8)+fileId(3)
    const raw = msbDeinterleave(interleaved);
    console.log(`   addr=${hexRun(body.slice(0, 8))} fileId=${hexRun(body.slice(8, 11))}  -> FILE_TYPE=${hex(fileType)}${fileType === PROJECT_FILE_TYPE ? ' (== project!)' : ' (NEW — sample type)'}`);
    if (isPcm) {
      dataBytesTotal += raw.length;
      if (!firstPayloadHead) firstPayloadHead = raw.slice(0, 64);
    } else {
      console.log(`   write_init payload (deinterleaved): ${hexRun(raw.slice(0, 32))}`);
    }
  } else if (subcmd === SUB.WRITE_FINISH) {
    console.log(`   finish payload: ${hexRun(body.slice(0, 16))}  (expect addr + fileId + CRC32 nibbles)`);
  }
}

console.log('\n===== SUMMARY (the answers we need) =====');
console.log(`file-type byte(s) seen: ${[...fileTypesSeen].map(hex).join(', ') || '(none — no WRITE frames found)'}`);
console.log(`sample command group differs from project's ${hex(HDR[5])}? ${nonProjectCmdGroup ? 'YES — different cmd group!' : 'no (same file-transfer group)'}`);
console.log(`total decoded payload bytes: ${dataBytesTotal}`);
if (firstPayloadHead) {
  console.log(`payload head (first 64 decoded bytes — look for a WAV "RIFF"/"fmt " header, a custom header, or raw PCM):`);
  console.log('  ' + hexRun(firstPayloadHead));
  const ascii = firstPayloadHead.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  console.log('  ascii: ' + ascii);
}
console.log('\nNext: with the file-type + payload format confirmed here, wiring uploadSample() is a small change\n(reuse uploadProject\'s session + in-transfer guard, swap fileId\'s type, encode WAV -> the format shown above).');
