/**
 * Golden: Circuit Tracks .ncs SysEx transfer payload (no hardware).
 *
 * Verifies the pure encode + frame-plan layer of the upload protocol:
 * MSB-interleave round-trip + known vector, CRC32 (standard check value),
 * block address / file id / nibble encodings, and the full upload frame plan
 * shape (29 frames, 20 data blocks, ACK expectations, WRITE_INIT bytes).
 * The bidirectional send loop is hardware-verified separately; this locks the
 * bytes that go on the wire.
 *
 * Run via:  npx tsx scripts/verify-circuit-ncs-transfer.ts
 */

import {
  blockAddress, buildUploadFrames, crc32, fileId, intToNibbles, isAckFor,
  makeMessage, msbDeinterleave, msbInterleave, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { downloadProject, probeProjectSlot, runUploadFramePlan, readPackCount, uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import {
  FILE_TYPE_SAMPLE, buildSampleUploadFrames, sampleBlockCount, sampleFileId,
} from '@mcp-midi-control/circuit-tracks/samples/sampleTransfer.js';
import { normalizeToDevice, parseWav } from '@mcp-midi-control/circuit-tracks/samples/wav.js';
import { writer } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { DispatchError, type DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

/** Build a minimal valid PCM WAV (for codec/round-trip checks). */
function makeWav(sampleRate: number, channels: number, bits: number, frames: number): Uint8Array {
  const bps = bits >> 3;
  const dataLen = frames * channels * bps;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bps, true); dv.setUint16(32, channels * bps, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < frames * channels; i++) dv.setInt16(44 + i * 2, ((i * 137) % 65536) - 32768, true);
  return buf;
}

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
const eq = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// CRC32 standard check value: crc32("123456789") = 0xCBF43926.
{
  const v = crc32(new TextEncoder().encode('123456789'));
  check('crc32("123456789") = 0xCBF43926', v === 0xcbf43926, '0x' + v.toString(16));
}

// MSB-interleave known vector + round-trip.
{
  const inp = [0x80, 0x01, 0x82, 0x03, 0x84, 0x05, 0x86];
  // bytes 0,2,4,6 have MSB set -> header = 0b01010101 = 0x55; low7 = 0..6
  check('msbInterleave known vector', eq(msbInterleave(inp), [0x55, 0, 1, 2, 3, 4, 5, 6]), JSON.stringify(msbInterleave(inp)));
  const rnd = Array.from({ length: 100 }, (_v, i) => (i * 37 + 13) & 0xff);
  check('msbInterleave round-trips', eq(msbDeinterleave(msbInterleave(rnd)), rnd));
  check('interleave is 7-bit clean', msbInterleave(rnd).every((b) => b <= 0x7f));
}

// Address / id / nibble encodings.
check('blockAddress(0)', eq(blockAddress(0), [0, 0, 0, 0, 0, 0, 0, 0]));
check('blockAddress(16) = page 1 offset 0', eq(blockAddress(16), [0, 0, 0, 0, 0, 0, 1, 0]));
check('blockAddress(21) = page 1 offset 5', eq(blockAddress(21), [0, 0, 0, 0, 0, 0, 1, 5]));
check('fileId(0)', eq(fileId(0), [3, 0, 0]));
check('fileId(63)', eq(fileId(63), [3, 0, 63]));
check('intToNibbles(160780,5)=[2,7,4,0,12]', eq(intToNibbles(NCS_FILE_SIZE, 5), [2, 7, 4, 0, 12]));

// Full upload frame plan.
{
  const ncs = new Uint8Array(NCS_FILE_SIZE);
  for (let i = 0; i < ncs.length; i++) ncs[i] = (i * 91 + 7) & 0xff; // arbitrary content
  const frames = buildUploadFrames(ncs, 0);
  const dataFrames = frames.filter((f) => f.label.startsWith('write_data'));
  check('frame plan: 29 frames total', frames.length === 29, String(frames.length));
  check('frame plan: 20 data blocks (ceil 160780/8192)', dataFrames.length === 20, String(dataFrames.length));
  check('every frame is F0..F7 framed', frames.every((f) => f.bytes[0] === 0xf0 && f.bytes[f.bytes.length - 1] === 0xf7));
  check('open + init + data + finish carry ACK expectations', frames.filter((f) => f.ack).length === 1 + 1 + 20 + 1);

  const init = frames.find((f) => f.label === 'write_init')!;
  // F0 00 20 29 01 64 03 01 <addr8> <fid3> 01 00 00 00 <size5> F7
  check('write_init header bytes', eq(init.bytes.slice(0, 8), [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x01]));
  check('write_init carries 5 size nibbles for 160780',
    eq(init.bytes.slice(init.bytes.length - 6, init.bytes.length - 1), [2, 7, 4, 0, 12]), JSON.stringify(init.bytes.slice(-6)));

  // data block: 8192 raw -> 1170 full groups x8 + (1 header + 2 remainder) = 9363 encoded bytes.
  const d1 = dataFrames[0].bytes;
  const overhead = 1 + 6 + 1 + 8 + 3 + 1; // F0+hdr+subcmd+addr+fid+F7
  check('data block 1 encoded length = 9363', d1.length - overhead === 9363, String(d1.length - overhead));

  // ACK matcher round-trips against a synthetic ACK for the init addr+fid.
  const ackBytes = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]);
  check('isAckFor matches a well-formed ACK', isAckFor(ackBytes, blockAddress(0), fileId(0)));
  check('isAckFor rejects wrong addr', !isAckFor(ackBytes, blockAddress(1), fileId(0)));
}

// Slot validation.
check('bad slot throws', (() => { try { buildUploadFrames(new Uint8Array(NCS_FILE_SIZE), 64); return false; } catch { return true; } })());
check('wrong size throws', (() => { try { buildUploadFrames(new Uint8Array(10), 0); return false; } catch { return true; } })());

// ── Always-close-session regression (the stuck-device incident, 2026-06-20) ──
// A failed transfer (empty-slot read / no-ACK upload) MUST still send
// CLOSE_SESSION, or the device is stranded in its transfer state and can
// watchdog-reboot. Driven against a mock connection that never replies; tiny
// timeouts + sleepScale keep it sub-second and offline.
{
  const mock = (): { sent: number[][]; conn: MidiConnection } => {
    const sent: number[][] = [];
    const conn = {
      send: (b: number[]) => { sent.push([...b]); },
      onMessage: (_h: (m: number[]) => void) => () => { /* never fires */ },
      hasInput: true,
      close: () => { /* noop */ },
      receiveSysEx: async () => { throw new Error('mock'); },
      receiveSysExMatching: async () => { throw new Error('mock'); },
    } as unknown as MidiConnection;
    return { sent, conn };
  };
  const closeFrame = makeMessage(TRANSFER_CONSTANTS.SUBCMD.CLOSE_SESSION);
  const fast = { responseTimeoutMs: 20, ackTimeoutMs: 20, sleepScale: 0.001 };

  const dm = mock();
  const dl = await downloadProject(dm.conn, 32, fast);
  check('downloadProject empty slot → result.empty (not a hard error)', dl.empty === true && dl.ok === false, JSON.stringify(dl));
  check('downloadProject ALWAYS closes the session last (no stranded transfer)',
    eq(dm.sent[dm.sent.length - 1], closeFrame), JSON.stringify(dm.sent[dm.sent.length - 1]));

  const um = mock();
  const up = await uploadProject(um.conn, new Uint8Array(NCS_FILE_SIZE), 32, fast);
  check('uploadProject no-ACK → ok:false', up.ok === false, JSON.stringify(up));
  check('uploadProject ALWAYS closes the session last (no stranded transfer)',
    eq(um.sent[um.sent.length - 1], closeFrame), JSON.stringify(um.sent[um.sent.length - 1]));
}

// ── B2: the DEAD-HANDLE paths (the reboot scenario) — previously untested ──
{
  const NCS = new Uint8Array(NCS_FILE_SIZE);
  const fast = { responseTimeoutMs: 20, ackTimeoutMs: 20, sleepScale: 0.001 };

  // A send that THROWS mid-transfer must abort at that block (not fire all 29),
  // return {ok:false} (NOT an uncaught throw), and not hang.
  {
    let nsent = 0; const deadAt = 3;
    const conn = {
      send: (_b: number[]) => { nsent++; if (nsent >= deadAt) throw new Error('Internal RtMidi error'); },
      onMessage: () => () => { /* */ }, hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    let threw = false; let res: { ok: boolean; error?: string } | undefined;
    try { res = await uploadProject(conn, NCS, 5, fast); } catch { threw = true; }
    check('uploadProject: a throwing send returns {ok:false}, NOT an uncaught throw', !threw && res?.ok === false, JSON.stringify({ threw, res }));
    check('uploadProject: aborts at the failing block (not all 29 frames)', nsent <= deadAt, `sent ${nsent}`);
  }

  // Pre-flight refuses a handle already in lastSendError state (0 frames sent).
  {
    let nsent = 0;
    const conn = {
      send: (_b: number[]) => { nsent++; }, onMessage: () => () => { /* */ }, hasInput: true,
      isPortOpen: () => true, close: () => { /* */ }, lastSendError: new Error('prior death'),
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    const res = await uploadProject(conn, NCS, 5, fast);
    check('uploadProject: pre-flight refuses a handle in error state (0 frames sent)',
      res.ok === false && /refused to start/.test(res.error ?? '') && nsent === 0, JSON.stringify({ res, nsent }));
  }

  // Pre-flight refuses a closed port (isPortOpen() === false).
  {
    let nsent = 0;
    const conn = {
      send: (_b: number[]) => { nsent++; }, onMessage: () => () => { /* */ }, hasInput: true,
      isPortOpen: () => false, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    const res = await uploadProject(conn, NCS, 5, fast);
    check('uploadProject: pre-flight refuses a closed port (0 frames sent)',
      res.ok === false && /not open/.test(res.error ?? '') && nsent === 0, JSON.stringify({ res, nsent }));
  }
}

// ── SAMPLE upload: byte-identity vs a real Components capture ──────────────
// Decoded from samples/captured/send-to-circuit-tracks-sleep-token-samples.pcapng
// (gitignored). The expected bytes below are the capture's actual frames for the
// first sample (slot 0, "01_k1_kick.wav" → device name "00_01_k1_kick.wav",
// WAV length 97242). buildSampleUploadFrames must reproduce them exactly.
check('FILE_TYPE_SAMPLE = 0x05 (projects are 0x03)', FILE_TYPE_SAMPLE === 0x05, '0x' + FILE_TYPE_SAMPLE.toString(16));
check('sampleFileId(0) = [5,0,0]', eq(sampleFileId(0), [5, 0, 0]));
check('sampleFileId(63) = [5,0,63]', eq(sampleFileId(63), [5, 0, 63]));
{
  const WAV_LEN = 97242;
  const wav = new Uint8Array(WAV_LEN); // content irrelevant to WRITE_INIT / SET_FILENAME framing
  const frames = buildSampleUploadFrames(wav, 0, '00_01_k1_kick.wav');

  // Capture-proven prelude (2026-06-23 decode): dir-listing is file-type 0x05
  // (SAMPLE dir) followed by a 64x 0x0d scan of that directory — this is what
  // commits the manifest so writes persist. Both must be present by default.
  const dirListing = frames.find((f) => f.label === 'dir_listing')!.bytes;
  check('sample session uses SAMPLE dir context 0x05',
    eq(dirListing, [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0b, 0x05, 0x00, 0xf7]), JSON.stringify(dirListing));
  const enum0d = frames.filter((f) => f.label.startsWith('enum0d'));
  check('sample session scans the 0x05 dir: 64x 0x0d enumeration by default', enum0d.length === 64, String(enum0d.length));
  check('first 0x0d enumeration frame targets sample dir slot 0',
    eq(enum0d[0].bytes, [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0d, 0x05, 0x00, 0x00, 0xf7]), JSON.stringify(enum0d[0]?.bytes));

  const init = frames.find((f) => f.label.startsWith('write_init'))!.bytes;
  const capInit = [
    0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x01, // envelope + WRITE_INIT
    0, 0, 0, 0, 0, 0, 0, 0,                          // addr(0)
    5, 0, 0,                                          // fileId: FILE_TYPE_SAMPLE, slot 0
    1, 0, 0, 0,                                       // init flags (same as project)
    1, 7, 0xb, 0xd, 0xa,                              // size nibbles for 97242
    0xf7,
  ];
  check('sample WRITE_INIT byte-identical to Components capture (slot 0, 97242B)', eq(init, capInit), JSON.stringify(init));

  const name = frames.find((f) => f.label.startsWith('set_filename'))!.bytes;
  const capName = [
    0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x07, 5, 0, 0,
    ...[...'00_01_k1_kick.wav'].map((c) => c.charCodeAt(0)), 0xf7,
  ];
  check('sample SET_FILENAME byte-identical to capture', eq(name, capName), JSON.stringify(name));
  check('sampleBlockCount(97242) = 12 blocks', sampleBlockCount(WAV_LEN) === 12, String(sampleBlockCount(WAV_LEN)));
}

// WRITE_DATA blocks reconstruct the source WAV byte-exact (interleave round-trip).
{
  const wav = makeWav(48000, 1, 16, 5000); // > 1 block (8192 B)
  const frames = buildSampleUploadFrames(wav, 7, 'tone.wav');
  const recon: number[] = [];
  for (const f of frames.filter((x) => x.label.startsWith('write_data'))) {
    recon.push(...msbDeinterleave(f.bytes.slice(1 + 6 + 1 + 8 + 3, f.bytes.length - 1)));
  }
  check('WRITE_DATA blocks reconstruct the source WAV byte-exact', eq(recon.slice(0, wav.length), [...wav]));
}

// WAV normalizer → device format (48 kHz mono 16-bit).
{
  const w441 = makeWav(44100, 2, 16, 441); // 44.1k STEREO
  const r = normalizeToDevice(w441);
  const p = parseWav(r.wav);
  check('normalizeToDevice 44.1k stereo → 48k mono 16-bit',
    r.converted && p.sampleRate === 48000 && p.channels === 1 && p.bitsPerSample === 16,
    JSON.stringify({ converted: r.converted, rate: p.sampleRate, ch: p.channels, bits: p.bitsPerSample }));
  const w48 = makeWav(48000, 1, 16, 480);
  const r2 = normalizeToDevice(w48);
  check('normalizeToDevice passes 48k mono 16-bit verbatim', r2.converted === false && eq([...r2.wav], [...w48]), JSON.stringify({ converted: r2.converted }));
}

// ── Stale-handle AUTO-RECOVERY: reconnect + retry once (the release-hardening) ──
// A handle-level fault (dead handle at pre-flight) must trigger reconnect() and
// retry the whole transfer on the FRESH handle, succeeding — so the user never
// runs reconnect_midi by hand. A device no-ACK must NOT reconnect (retrying a
// busy device on a fresh handle would just fail again).
{
  const fast = { responseTimeoutMs: 30, ackTimeoutMs: 30, sleepScale: 0.001 };
  const frames = buildSampleUploadFrames(makeWav(48000, 1, 16, 200), 0, 'x.wav');

  // Healthy handle that ACKs every send (mirrors the device frame-ack).
  const ackingConn = (): MidiConnection => {
    let handler: ((m: number[]) => void) | undefined;
    return {
      send: () => {
        const ack = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]);
        queueMicrotask(() => handler?.(ack));
      },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
  };
  // Dead handle: pre-flight fails (lastSendError set).
  const deadConn = (): MidiConnection => ({
    send: () => { /* */ }, onMessage: () => () => { /* */ }, hasInput: true, isPortOpen: () => true,
    lastSendError: new Error('prior death'), close: () => { /* */ },
    receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
  } as unknown as MidiConnection);
  // Healthy handle whose device is silent (no-ACK).
  const silentConn = (): MidiConnection => ({
    send: () => { /* */ }, onMessage: () => () => { /* */ }, hasInput: true, isPortOpen: () => true, close: () => { /* */ },
    receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
  } as unknown as MidiConnection);

  let reconnects = 0;
  const r1 = await runUploadFramePlan(deadConn(), frames, { ...fast, reconnect: () => { reconnects++; return ackingConn(); } });
  check('auto-recovery: stale handle → reconnect + retry SUCCEEDS', r1.ok === true && reconnects === 1, JSON.stringify({ r1, reconnects }));

  const r2 = await runUploadFramePlan(deadConn(), frames, fast); // no reconnect callback
  check('auto-recovery: no reconnect callback → fails, no retry', r2.ok === false && /refused to start/.test(r2.error ?? ''), JSON.stringify(r2));

  let rc = 0;
  const r3 = await runUploadFramePlan(silentConn(), frames, { ...fast, reconnect: () => { rc++; return ackingConn(); } });
  check('auto-recovery: a no-ACK does NOT reconnect (device-level, not handle)', r3.ok === false && rc === 0 && /no ACK/.test(r3.error ?? ''), JSON.stringify({ r3, rc }));

  // Recording acking handle (so we can assert the retry leads with CLOSE_SESSION).
  const recordingAck = (): { conn: MidiConnection; sent: number[][] } => {
    const sent: number[][] = []; let handler: ((m: number[]) => void) | undefined;
    const conn = {
      send: (b: number[]) => { sent.push([...b]); const a = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]); queueMicrotask(() => handler?.(a)); },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    return { conn, sent };
  };
  // ACKs the first throwAt-1 sends, then THROWS — i.e. dies MID-transfer (after started=true).
  const throwingAfter = (throwAt: number): MidiConnection => {
    let handler: ((m: number[]) => void) | undefined; let n = 0;
    return {
      send: () => { n++; if (n >= throwAt) throw new Error('Internal RtMidi error'); const a = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]); queueMicrotask(() => handler?.(a)); },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
  };

  // (a) MID-SEND throw → reconnect → retry from the top; the fresh handle must lead with CLOSE_SESSION
  // (the session reset), the device-reboot-risk path the in-transfer guard exists to make safe.
  {
    let recon = 0; const fresh = recordingAck();
    const ra = await runUploadFramePlan(throwingAfter(4), frames, { ...fast, reconnect: () => { recon++; return fresh.conn; } });
    check('auto-recovery: MID-SEND throw → reconnect + retry succeeds, fresh handle leads with CLOSE_SESSION',
      ra.ok === true && recon === 1 && eq(fresh.sent[0], makeMessage(TRANSFER_CONSTANTS.SUBCMD.CLOSE_SESSION)),
      JSON.stringify({ ra, recon, first: fresh.sent[0] }));
  }
  // (b) reconnect() itself throws → honest "auto-reconnect also failed".
  const rb = await runUploadFramePlan(deadConn(), frames, { ...fast, reconnect: () => { throw new Error('port busy'); } });
  check('auto-recovery: reconnect() throws → ok:false + "auto-reconnect also failed"', rb.ok === false && /auto-reconnect also failed/.test(rb.error ?? ''), JSON.stringify(rb));
  // (c) reconnect returns a STILL-dead handle → "retried once; still failed".
  const rcc = await runUploadFramePlan(deadConn(), frames, { ...fast, reconnect: () => deadConn() });
  check('auto-recovery: reconnect returns a dead handle → "retried once; still failed"', rcc.ok === false && /retried once/.test(rcc.error ?? ''), JSON.stringify(rcc));
  // (d) DOWNLOAD side also reconnects on a stale handle (then empty on the fresh silent handle).
  let dlRecon = 0;
  const dlr = await downloadProject(deadConn(), 5, { ...fast, reconnect: () => { dlRecon++; return silentConn(); } });
  check('auto-recovery: download stale handle → reconnect fires', dlRecon === 1 && dlr.empty === true, JSON.stringify({ dlr, dlRecon }));
}

// ── Occupancy probe (#0 read-half): empty vs occupied(+name) vs unknown ──────
// The read primitive behind the overwrite gate. Fast opts keep it sub-second.
{
  const SUB = TRANSFER_CONSTANTS.SUBCMD;
  const HDRLEN = TRANSFER_CONSTANTS.HEADER.length;
  const subcmdOf = (frame: readonly number[]) => frame[1 + HDRLEN]; // F0 + HEADER + subcmd
  const fast = { responseTimeoutMs: 20, ackTimeoutMs: 20, sleepScale: 0.001 };

  // Never replies → the probe reads the slot as EMPTY (no READ_INIT in window).
  const silent = (): MidiConnection => ({
    send: () => { /* */ }, onMessage: () => () => { /* */ }, hasInput: true, isPortOpen: () => true, close: () => { /* */ },
    receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
  } as unknown as MidiConnection);
  // Answers the read handshake's WRITE_INIT with READ_INIT + one WRITE_DATA
  // (carrying a project name at offset 0x10) + WRITE_FINISH → reads as OCCUPIED.
  const occupiedConn = (name: string, slot: number): MidiConnection => {
    let handler: ((m: number[]) => void) | undefined;
    const chunk = new Uint8Array(0x20);
    for (let i = 0; i < name.length && i < 16; i++) chunk[0x10 + i] = name.charCodeAt(i);
    const readInit = makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fileId(slot), 1, 0, 0, 0, 2, 7, 4, 0, 12]);
    const dataMsg = makeMessage(SUB.WRITE_DATA, [...blockAddress(0), ...fileId(slot), ...msbInterleave(chunk)]);
    const finish = makeMessage(SUB.WRITE_FINISH, [...blockAddress(1), ...fileId(slot), 0, 0, 0, 0, 0, 0, 0, 0]);
    return {
      send: (b: number[]) => {
        if (subcmdOf(b) === SUB.WRITE_INIT) for (const m of [readInit, dataMsg, finish]) { const mm = m; queueMicrotask(() => handler?.(mm)); }
      },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
  };

  const empty = await probeProjectSlot(silent(), 20, fast);
  check('probe: empty slot → {status:"empty"}', empty.status === 'empty', JSON.stringify(empty));
  const occ = await probeProjectSlot(occupiedConn('GRANITE', 33), 33, fast);
  check('probe: occupied slot → {status:"occupied", name}', occ.status === 'occupied' && occ.status === 'occupied' && occ.name === 'GRANITE', JSON.stringify(occ));
}

// ── Overwrite GATE (#0): the safe-edit read-before-write contract on the ──────
// destructive transfer tools, exercised through the device WRITER. Empty → write
// through; occupied → refuse (overwrite_confirmation_required) + name; sample
// slots → refuse by default (no dir read); confirm_overwrite skips the gate.
// The writer uses production transfer timing (it exposes no test knob), so these
// stay to the FAST paths: a refusal sends nothing, and confirm_overwrite skips
// the (slow) occupancy read. The slow empty-read path is covered by the probe
// test above; here we assert the gate WIRING + refusal messages.
{
  const SUB = TRANSFER_CONSTANTS.SUBCMD;
  const HDRLEN = TRANSFER_CONSTANTS.HEADER.length;
  const subcmdOf = (frame: readonly number[]) => frame[1 + HDRLEN];
  const ctxOf = (conn: MidiConnection): DispatchCtx =>
    ({ conn, descriptor: {} as never, reconnect: () => conn }) as unknown as DispatchCtx;

  // ACKs every send so an upload that passes the gate completes; never emits a
  // READ_INIT (irrelevant here — every writer call below is no-read).
  const COMMIT_FRAME = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x08, 0x00, 0xf7];
  const acking = (): { conn: MidiConnection; sent: number[][] } => {
    const sent: number[][] = []; let handler: ((m: number[]) => void) | undefined;
    const conn = {
      send: (b: number[]) => {
        sent.push([...b]);
        const a = makeMessage(SUB.ACK, [...blockAddress(0), ...fileId(0)]); queueMicrotask(() => handler?.(a));
        // Answer the active-pack-index read (0b 02 query) with pack 0.
        if (b[7] === SUB.DIR_CONTROL && b[8] === 0x02) queueMicrotask(() => handler?.(makeMessage(SUB.DIR_CONTROL, [0x02, 0x00])));
        // On CLOSE, also emit the device's post-CLOSE flash-commit (sample uploads await it).
        if (b[7] === SUB.CLOSE_SESSION) queueMicrotask(() => handler?.(COMMIT_FRAME));
      },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    return { conn, sent };
  };
  const NCS = new Uint8Array(NCS_FILE_SIZE);
  const sampleWav = makeWav(48000, 1, 16, 200);
  const isOverwriteRefusal = (e: unknown) => e instanceof DispatchError && e.code === 'overwrite_confirmation_required';
  const grab = async (fn: () => Promise<unknown>): Promise<{ threw: boolean; err?: unknown; res?: unknown }> => {
    try { return { threw: false, res: await fn() }; } catch (err) { return { threw: true, err }; }
  };

  // upload_sample: no confirm → refuse (sample slots can't be read), 0 frames sent.
  {
    const m = acking();
    const r = await grab(() => writer.uploadSample!(ctxOf(m.conn), sampleWav, 4, 's.wav'));
    check('gate: upload_sample without confirm_overwrite REFUSES (overwrite_confirmation_required)',
      r.threw && isOverwriteRefusal(r.err) && /slot 5/.test((r.err as Error).message), JSON.stringify({ threw: r.threw, msg: (r.err as Error | undefined)?.message }));
    check('gate: refused upload_sample sent ZERO frames', m.sent.length === 0, `sent ${m.sent.length}`);
  }
  // upload_kit: no confirm → refuse, naming the slot RANGE, 0 frames sent.
  {
    const m = acking();
    const items = [0, 1, 2].map((i) => ({ wav: sampleWav, slot: i, filename: `k${i}.wav` }));
    const r = await grab(() => writer.uploadKit!(ctxOf(m.conn), items));
    check('gate: upload_kit without confirm_overwrite REFUSES, names the slot range',
      r.threw && isOverwriteRefusal(r.err) && /slots 1\.\.3/.test((r.err as Error).message), JSON.stringify((r.err as Error | undefined)?.message));
    check('gate: refused upload_kit sent ZERO frames', m.sent.length === 0, `sent ${m.sent.length}`);
  }
  // upload_sample: confirm:true → gate passes, the (acked) transfer runs, ok:true.
  {
    const m = acking();
    const r = await grab(() => writer.uploadSample!(ctxOf(m.conn), sampleWav, 4, 's.wav', { confirmOverwrite: true }));
    check('gate: upload_sample with confirm_overwrite proceeds (ok:true)',
      !r.threw && (r.res as { ok: boolean }).ok === true, JSON.stringify({ threw: r.threw, err: (r.err as Error | undefined)?.message }));
  }
  // SET_FILENAME REJECTION (empty/uninitialized pack directory): the device does
  // NOT ack the slot registration → the upload now FAILS LOUD with a directory
  // error instead of the old "all acked" false success (decoded 2026-06-27,
  // pack-send capture vs _our-single-timeline; this is the bug that hid the wipe).
  {
    const frames = buildSampleUploadFrames(normalizeToDevice(sampleWav).wav, 4, 's.wav');
    let handler: ((m: number[]) => void) | undefined;
    const conn = {
      send: (b: number[]) => {
        // ACK every frame EXCEPT set_filename — simulates the empty-directory reject.
        if (b[7] !== SUB.SET_FILENAME) {
          queueMicrotask(() => handler?.(makeMessage(SUB.ACK, [...blockAddress(0), ...fileId(0)])));
          if (b[7] === SUB.CLOSE_SESSION) queueMicrotask(() => handler?.(COMMIT_FRAME));
        }
      },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    // ackTimeoutMs must outlive event-loop load for the ACKED frames; the
    // deliberately-unACKed set_filename then times out as intended.
    const rr = await runUploadFramePlan(conn, frames, { ackTimeoutMs: 300, sleepScale: 0.001, singleClose: true });
    check('SET_FILENAME rejection → upload ok:false (no false success)', rr.ok === false, JSON.stringify(rr));
    check('SET_FILENAME rejection → error names the UNINITIALIZED directory', /UNINITIALIZED|directory/.test(rr.error ?? ''), rr.error);
  }
  // PACK INDEX (decoded 2026-06-27): sample frames carry the device's ACTIVE pack
  // index (its 0b 02 reply), not a hardcoded 0. sampleFileId = [0x05, pack, slot];
  // our old [0x05, slot>>7, slot] was [0x05, 0, slot] = pack 0 by accident → the
  // "0/64" bug whenever the active pack wasn't 0.
  {
    check('sampleFileId(5) defaults pack 0 → [05,00,05]', JSON.stringify(sampleFileId(5)) === JSON.stringify([0x05, 0x00, 0x05]));
    check('sampleFileId(5, 2) → [05,02,05] (pack is the middle byte)', JSON.stringify(sampleFileId(5, 2)) === JSON.stringify([0x05, 0x02, 0x05]));
    const fr = buildSampleUploadFrames(makeWav(48000, 1, 16, 200), 5, 'x.wav', { packIndex: 2 });
    const listing = fr.find((f) => f.label === 'dir_listing')!;
    check('buildSampleUploadFrames(pack 2): dir_listing = 0b 05 02',
      listing.bytes[7] === SUB.DIR_CONTROL && listing.bytes[8] === FILE_TYPE_SAMPLE && listing.bytes[9] === 0x02);
    const setf = fr.find((f) => f.label.startsWith('set_filename'))!;
    check('buildSampleUploadFrames(pack 2): SET_FILENAME = 07 05 02 05',
      setf.bytes[7] === SUB.SET_FILENAME && setf.bytes[8] === FILE_TYPE_SAMPLE && setf.bytes[9] === 0x02 && setf.bytes[10] === 5);
    // readPackCount parses the COUNT byte from the pack-directory header reply
    // (0b 02 <count>). CORRECTED 2026-07-16: this used to assert the byte was an
    // "active pack index" — it is the number of packs on the card, confirmed by
    // the pack-2 capture (0b 02 01, one pack), the pack-3 capture (0b 02 02, two
    // packs), and the maintainer's 5-pack device (0b 02 05). See
    // docs/design/circuit-pack-addressing.md §3. There is NO command that reports
    // the ACTIVE pack; do not reintroduce that reading on this frame.
    let handler: ((m: number[]) => void) | undefined;
    const conn = {
      send: (b: number[]) => { if (b[7] === SUB.DIR_CONTROL && b[8] === 0x02) queueMicrotask(() => handler?.(makeMessage(SUB.DIR_CONTROL, [0x02, 0x03]))); },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    const n = await readPackCount(conn, 500);
    check('readPackCount parses the 0b 02 header reply → card holds 3 packs (COUNT, not an active-pack index)', n === 3, String(n));
  }
  // upload_project: confirm:true → SKIPS the occupancy read, writes (ok:true).
  {
    const m = acking();
    const r = await grab(() => writer.uploadProject!(ctxOf(m.conn), NCS, 33, { confirmOverwrite: true }));
    check('gate: upload_project with confirm_overwrite writes (ok:true)',
      !r.threw && (r.res as { ok: boolean }).ok === true, JSON.stringify({ threw: r.threw, err: (r.err as Error | undefined)?.message }));
    // The upload's OWN handshake sends a WRITE_INIT; an occupancy READ would send
    // a SECOND one (its read-request). Exactly one ⇒ the read was skipped.
    const writeInits = m.sent.filter((f) => subcmdOf(f) === SUB.WRITE_INIT).length;
    check('gate: confirm_overwrite SKIPS the occupancy read (only the upload\'s WRITE_INIT, no read-request)',
      writeInits === 1, `WRITE_INIT count = ${writeInits} (expected 1)`);
  }
}

// ── SAMPLE COMMIT-WAIT: the post-CLOSE flash-commit notification (decoded from two
// Components captures 2026-06-23). The device flushes the pack manifest ~6-8s AFTER
// CLOSE, then sends F0 00 20 29 01 64 08 00 F7 (group 0x08, subcmd 0x00). The transport
// must (a) BUFFER it — its group byte is 0x08, not the request group 0x03, so the old
// 0x03-only ingest dropped it — and (b) WAIT for it (awaitCommitMs) before returning ok.
// Without it the slots read back empty (the 0/64 acks-but-no-commit bug).
{
  const COMMIT = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x08, 0x00, 0xf7];
  const frames = buildSampleUploadFrames(makeWav(48000, 1, 16, 200), 0, 'x.wav');
  // ACKs every send; on a CLOSE (0x41) ALSO emits the commit notification iff sendCommit.
  const commitConn = (sendCommit: boolean): MidiConnection => {
    let handler: ((m: number[]) => void) | undefined;
    return {
      send: (b: number[]) => {
        const ack = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]);
        queueMicrotask(() => handler?.(ack));
        if (sendCommit && b[1 + TRANSFER_CONSTANTS.HEADER.length] === TRANSFER_CONSTANTS.SUBCMD.CLOSE_SESSION) {
          queueMicrotask(() => handler?.(COMMIT));
        }
      },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
  };
  // Load-tolerant (full-preflight flake): ACKs + the commit frame arrive via
  // microtask; the windows only bound the DELIBERATE-timeout cases below.
  const opts = { responseTimeoutMs: 300, ackTimeoutMs: 300, sleepScale: 0.001, awaitCommitMs: 500 };
  const good = await runUploadFramePlan(commitConn(true), frames, opts);
  check('commit-wait: device sends the 0x08-group commit → upload ok (frame buffered + awaited)', good.ok === true, JSON.stringify(good));
  const bad = await runUploadFramePlan(commitConn(false), frames, opts);
  check('commit-wait: NO commit frame → ok:false (does not falsely report success)',
    bad.ok === false && /commit signal/.test(bad.error ?? ''), JSON.stringify(bad));
  // Without awaitCommitMs (the PROJECT path), CLOSE is fire-and-return — no commit needed.
  const legacy = await runUploadFramePlan(commitConn(false), frames, { responseTimeoutMs: 300, ackTimeoutMs: 300, sleepScale: 0.001 });
  check('commit-wait: project path (no awaitCommitMs) unchanged — ok without a commit frame', legacy.ok === true, JSON.stringify(legacy));
}

// ── SAMPLE singleClose: Components sends OPEN×1 + CLOSE×1 per upload (both captures);
// our default sends CLOSE up to 3× (pre-reset + plan + finally). The extra closes
// around the device's multi-second flush appear to strand the session (device stuck
// in the upload/download display, no commit). `singleClose` sends exactly one.
{
  const frames = buildSampleUploadFrames(makeWav(48000, 1, 16, 200), 0, 'x.wav');
  // (fast below is load-tolerant: acking mock, see the auto-recovery block note.)
  const recOf = (): { conn: MidiConnection; sent: number[][] } => {
    const sent: number[][] = []; let handler: ((m: number[]) => void) | undefined;
    const conn = {
      send: (b: number[]) => { sent.push([...b]); const a = makeMessage(TRANSFER_CONSTANTS.SUBCMD.ACK, [...blockAddress(0), ...fileId(0)]); queueMicrotask(() => handler?.(a)); },
      onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
      hasInput: true, isPortOpen: () => true, close: () => { /* */ },
      receiveSysEx: async () => { throw new Error('m'); }, receiveSysExMatching: async () => { throw new Error('m'); },
    } as unknown as MidiConnection;
    return { conn, sent };
  };
  const fast = { responseTimeoutMs: 300, ackTimeoutMs: 300, sleepScale: 0.001 };
  const closesIn = (sent: number[][]) => sent.filter((f) => f[1 + TRANSFER_CONSTANTS.HEADER.length] === TRANSFER_CONSTANTS.SUBCMD.CLOSE_SESSION).length;
  const opensIn = (sent: number[][]) => sent.filter((f) => f[1 + TRANSFER_CONSTANTS.HEADER.length] === TRANSFER_CONSTANTS.SUBCMD.OPEN_SESSION).length;

  const a = recOf();
  const ra = await runUploadFramePlan(a.conn, frames, { ...fast, singleClose: true });
  check('singleClose: upload ok', ra.ok === true, JSON.stringify(ra));
  check('singleClose: sends OPEN×1 + CLOSE×1 (Components-faithful)', opensIn(a.sent) === 1 && closesIn(a.sent) === 1, `opens=${opensIn(a.sent)} closes=${closesIn(a.sent)}`);

  const b = recOf();
  await runUploadFramePlan(b.conn, frames, fast); // default project path (no singleClose)
  check('default (project) path still sends CLOSE 3× (pre-reset + plan + finally)', closesIn(b.sent) === 3, `closes=${closesIn(b.sent)}`);
}

console.log('');
if (failed > 0) { console.error(`x ${failed} ncs-transfer check(s) FAILED.`); process.exit(1); }
console.log('OK verify-circuit-ncs-transfer: upload payload + frame plan + always-close + SAMPLE upload (capture byte-identity + WAV codec + commit-wait mechanism + singleClose) + stale-handle auto-recovery + occupancy probe + overwrite gate verified (offline).');
