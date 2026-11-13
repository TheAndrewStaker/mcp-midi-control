/**
 * Decode a USBPcap capture of Arturia MIDI Control Center writing preset(s)
 * to a MicroFreak, into per-direction SysEx streams segmented into write
 * EVENTS, and report the framing evidence needed to decode the preset WRITE
 * opcode (the read side is already decoded: 146-packet / 4,672-byte dump).
 *
 * Prepared 2026-08-09 ahead of the capture session
 * (docs/_private/CAPTURE-PLAN-microfreak-preset-write.md). The pcapng /
 * USBPcap / USB-MIDI pipeline is lifted from decode-usbpcap-axefx.ts.
 *
 * Expected capture protocol: three time-separated drags in MCC
 *   (1) preset X -> slot 505   (2) preset X -> slot 506   (3) preset Y -> slot 506
 * so event1 vs event2 isolates slot-address bytes and event2 vs event3
 * isolates content bytes.
 *
 * Usage:
 *   npx tsx scripts/_research/decode-mcc-preset-write.ts <capture.pcapng>
 *     [--gap <seconds>]        event-segmentation quiet gap (default 2)
 *     [--dump-events <dir>]    write each event's OUT SysEx frames as .syx
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ARTURIA_PREFIX = [0xf0, 0x00, 0x20, 0x6b]; // manufacturer 00 20 6B

function hex(b: number, w = 2): string { return b.toString(16).padStart(w, '0'); }
function toHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map((b) => hex(b)).join(' ');
}

// ─── pcapng / USBPcap / USB-MIDI pipeline (see decode-usbpcap-axefx.ts) ───

const BLOCK_EPB = 0x00000006;

function* iteratePcapngBlocks(buf: Buffer): Generator<{ type: number; body: Buffer }> {
  let off = 0;
  while (off + 8 <= buf.length) {
    const blockType = buf.readUInt32LE(off);
    const blockLen = buf.readUInt32LE(off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break;
    yield { type: blockType, body: buf.subarray(off + 8, off + blockLen - 4) };
    off += blockLen;
  }
}

function parseEpb(body: Buffer): { tsHi: number; tsLo: number; data: Buffer } | null {
  if (body.length < 20) return null;
  const tsHi = body.readUInt32LE(4);
  const tsLo = body.readUInt32LE(8);
  const capLen = body.readUInt32LE(12);
  if (20 + capLen > body.length) return null;
  return { tsHi, tsLo, data: Buffer.from(body.subarray(20, 20 + capLen)) };
}

function parseUsbPcap(packet: Buffer): { endpoint: number; transferType: number; direction: 'IN' | 'OUT'; payload: Buffer } | null {
  if (packet.length < 27) return null;
  const headerLen = packet.readUInt16LE(0);
  if (headerLen > packet.length) return null;
  const endpoint = packet.readUInt8(21);
  const transferType = packet.readUInt8(22);
  const dataLength = packet.readUInt32LE(23);
  const direction = (packet.readUInt8(16) & 0x01) ? 'IN' : 'OUT';
  return { endpoint, transferType, direction, payload: packet.subarray(headerLen, headerLen + dataLength) };
}

function decodeUsbMidi(payload: Buffer): number[] {
  const midi: number[] = [];
  for (let i = 0; i + 4 <= payload.length; i += 4) {
    const cin = payload[i] & 0x0f;
    const b1 = payload[i + 1], b2 = payload[i + 2], b3 = payload[i + 3];
    switch (cin) {
      case 0x4: case 0x7: midi.push(b1, b2, b3); break;
      case 0x5: midi.push(b1); break;
      case 0x6: midi.push(b1, b2); break;
      case 0x8: case 0x9: case 0xa: case 0xb: case 0xe: midi.push(b1, b2, b3); break;
      case 0xc: case 0xd: midi.push(b1, b2); break;
      case 0xf: midi.push(b1); break;
      default: break;
    }
  }
  return midi;
}

// ─── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const gapArg = args.indexOf('--gap');
const gapSec = gapArg >= 0 ? Number(args[gapArg + 1]) : 2;
const dumpArg = args.indexOf('--dump-events');
const dumpDir = dumpArg >= 0 ? args[dumpArg + 1] : undefined;

if (!file) { console.error('Usage: decode-mcc-preset-write <capture.pcapng> [--gap s] [--dump-events dir]'); process.exit(1); }
const abs = path.resolve(file);
if (!existsSync(abs)) { console.error(`Not found: ${abs}`); process.exit(1); }

const buf = readFileSync(abs);
console.log(`File: ${abs} (${buf.length} bytes)`);

interface TimedFrame { ts: number; direction: 'IN' | 'OUT'; endpoint: number; bytes: number[] }
const perStream = new Map<string, { current: number[] | null }>();
const frames: TimedFrame[] = [];
let epbCount = 0;

for (const { type, body } of iteratePcapngBlocks(buf)) {
  if (type !== BLOCK_EPB) continue;
  epbCount++;
  const epb = parseEpb(body);
  if (!epb) continue;
  const usb = parseUsbPcap(epb.data);
  if (!usb || usb.transferType !== 0x03 || usb.payload.length < 4) continue;
  const key = `${usb.direction}/${usb.endpoint}`;
  let st = perStream.get(key);
  if (!st) { st = { current: null }; perStream.set(key, st); }
  const ts = epb.tsHi * 0x100000000 + epb.tsLo; // microseconds (default tsresol)
  for (const b of decodeUsbMidi(usb.payload)) {
    if (b === 0xf0) st.current = [0xf0];
    else if (st.current !== null) {
      st.current.push(b);
      if (b === 0xf7) {
        frames.push({ ts, direction: usb.direction, endpoint: usb.endpoint, bytes: st.current });
        st.current = null;
      }
    }
  }
}
frames.sort((a, b) => a.ts - b.ts);

const isArturia = (f: number[]): boolean => ARTURIA_PREFIX.every((b, i) => f[i] === b);
const art = frames.filter((f) => isArturia(f.bytes));
const other = frames.filter((f) => !isArturia(f.bytes));
console.log(`EPBs: ${epbCount}; SysEx frames: ${frames.length} (Arturia ${art.length}, other ${other.length})`);
if (other.length > 0) {
  console.log(`  non-Arturia frames (first 3): ${other.slice(0, 3).map((f) => toHex(f.bytes.slice(0, 12))).join(' | ')}`);
}
if (art.length === 0) { console.log('No Arturia SysEx found — wrong interface captured?'); process.exit(1); }

// Header shape: F0 00 20 6B <dev> <?> <seq> <opcode> ... — report the byte
// distribution at offsets 4..8 across all frames before assuming positions.
for (const off of [4, 5, 6, 7, 8]) {
  const counts = new Map<number, number>();
  for (const f of art) counts.set(f.bytes[off], (counts.get(f.bytes[off]) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([v, n]) => `0x${hex(v)}:${n}`).join('  ');
  console.log(`byte[${off}] distribution: ${top}${counts.size > 8 ? `  (+${counts.size - 8} more values)` : ''}`);
}

// ─── Event segmentation by quiet gap ──────────────────────────────────────
const GAP_US = gapSec * 1_000_000;
interface Ev { frames: TimedFrame[] }
const events: Ev[] = [];
let cur: Ev | null = null;
let lastTs = -Infinity;
for (const f of art) {
  if (f.ts - lastTs > GAP_US) { cur = { frames: [] }; events.push(cur); }
  cur!.frames.push(f);
  lastTs = f.ts;
}
console.log(`\n${events.length} event(s) at a ${gapSec}s quiet gap:`);
events.forEach((ev, i) => {
  const out = ev.frames.filter((f) => f.direction === 'OUT');
  const inn = ev.frames.filter((f) => f.direction === 'IN');
  const t0 = ev.frames[0].ts, t1 = ev.frames[ev.frames.length - 1].ts;
  const lens = new Map<number, number>();
  for (const f of out) lens.set(f.bytes.length, (lens.get(f.bytes.length) ?? 0) + 1);
  const lenSummary = [...lens.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}B×${n}`).join(' ');
  console.log(`  event ${i + 1}: ${(t1 - t0) / 1e6}s, OUT ${out.length} frames [${lenSummary}], IN ${inn.length} frames`);
  console.log(`    first OUT: ${toHex(out[0]?.bytes.slice(0, 16) ?? [])}…`);
  console.log(`    last  OUT: ${toHex(out[out.length - 1]?.bytes.slice(0, 16) ?? [])}…`);
  if (inn.length > 0) console.log(`    first IN : ${toHex(inn[0].bytes.slice(0, 16))}…`);
});

// ─── Cross-event diffs (the decode payload) ───────────────────────────────
// The seq byte (offset 6 of every Arturia frame) advances across all events,
// so it is MASKED to 0x00 before diffing — otherwise it pollutes every diff.
// Bucket rule for reading the diffs: bytes differing in event1-vs-event2 =
// slot address; in event2-vs-event3 = content; in BOTH = candidate
// checksum/counter (name that bucket first, do not misfile it).
function concatOut(ev: Ev): number[] {
  return ev.frames
    .filter((f) => f.direction === 'OUT')
    .flatMap((f) => f.bytes.map((b, i) => (i === 6 ? 0x00 : b)));
}
function diffReport(a: number[], b: number[], label: string): void {
  const n = Math.min(a.length, b.length);
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diffs.push(i);
  console.log(`\n${label}: lengths ${a.length} vs ${b.length}; ${diffs.length} differing byte(s) in the common prefix`);
  for (const d of diffs.slice(0, 24)) {
    console.log(`  off ${d}: 0x${hex(a[d])} -> 0x${hex(b[d])}`);
  }
  if (diffs.length > 24) console.log(`  … ${diffs.length - 24} more`);
}
if (events.length >= 2) diffReport(concatOut(events[0]), concatOut(events[1]), 'event1 vs event2 (same content, different slot => slot-address bytes)');
if (events.length >= 3) diffReport(concatOut(events[1]), concatOut(events[2]), 'event2 vs event3 (same slot, different content => content region)');

// ─── Optional per-event .syx dump for downstream tooling ──────────────────
if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true });
  events.forEach((ev, i) => {
    const out = Buffer.from(ev.frames.filter((f) => f.direction === 'OUT').flatMap((f) => f.bytes));
    const inn = Buffer.from(ev.frames.filter((f) => f.direction === 'IN').flatMap((f) => f.bytes));
    writeFileSync(path.join(dumpDir, `event${i + 1}-out.syx`), out);
    writeFileSync(path.join(dumpDir, `event${i + 1}-in.syx`), inn);
  });
  console.log(`\nWrote per-event .syx pairs to ${dumpDir}`);
}
