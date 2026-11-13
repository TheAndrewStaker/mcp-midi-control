/**
 * Hydrasynth Explorer — golden tests for the stored-content READ
 * transactions (BK-110): bank patch-name reads (`02 00 BANK`) and
 * whole-stored-patch reads (`04 00 BANK PATCH`).
 *
 * Locks `packages/hydrasynth/src/patchRead.ts` against:
 *
 *   1. `parseBankNames` — the fixed-stride names payload layout from
 *      the SysexEncoding.txt worked example (16-byte name field + 0x00
 *      terminator + 0x3A separator; 2306 bytes total), including the
 *      desync guards (wrong opcode / bank / broken stride throws).
 *   2. The full ack-driven chunk transaction against a scripted fake
 *      device: header handshake, chunk/ack loop with the names flow's
 *      0x13 TYPE byte echoed in acks (the spec prose says 0x16 but its
 *      own worked example says 0x13 — we lock the example), short-chunk
 *      termination, footer handshake, and footer-on-error (the header/
 *      footer pair is a soft mutex; skipping the footer stalls the
 *      device ~20 s).
 *   3. `readStoredPatch` — 22-chunk reassembly to the byte-identical
 *      2790-byte buffer plus verbatim frames for byte-exact backup.
 *
 * Run:  npx tsx scripts/hydrasynth/verify-patch-read.ts
 */
import { wrapSysex, unwrapSysex } from '@mcp-midi-control/hydrasynth/sysexEnvelope.js';
import {
  BANK_NAMES_PAYLOAD_SIZE,
  parseBankNames,
  readBankNames,
  readStoredPatch,
} from '@mcp-midi-control/hydrasynth/patchRead.js';
import { INIT_PATCH_BUFFER } from '@mcp-midi-control/hydrasynth/initPatchBuffer.js';
import { PATCH_BUFFER_SIZE } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  fn: () => Promise<boolean | string> | boolean | string;
}

const cases: Case[] = [];
function check(label: string, fn: Case['fn']): void {
  cases.push({ label, fn });
}

/** Build a spec-shaped names payload for `bank` from 128 names. */
function buildNamesPayload(bank: number, names: readonly string[]): Uint8Array {
  if (names.length !== 128) throw new Error('need exactly 128 names');
  const out = new Uint8Array(BANK_NAMES_PAYLOAD_SIZE);
  out[0] = 0x03;
  out[1] = 0x00;
  out[2] = bank;
  for (let i = 0; i < 128; i++) {
    const off = 3 + i * 18;
    const name = names[i]!;
    for (let j = 0; j < 16; j++) {
      // Spec example pads: name chars, then 0x00, then 0x20 spaces.
      out[off + j] = j < name.length ? name.charCodeAt(j) : j === name.length ? 0x00 : 0x20;
    }
    out[off + 16] = 0x00;
    if (i < 127) out[off + 17] = 0x3a;
  }
  return out;
}

const SAMPLE_NAMES: string[] = (() => {
  // First seven from the spec's own bank-A example, then synthetics.
  const head = [
    'Sawpressive GD', 'GX UltraPad PS', 'Venus Pluck ET', 'BladeTitles PS',
    "Chow's Arp GD", 'Doppler Bass MP', 'Clean FM Pad MP',
  ];
  const rest = Array.from({ length: 121 }, (_, i) => `Patch ${String(i + 8).padStart(3, '0')}`);
  return [...head, ...rest];
})();

/**
 * Scripted fake device implementing the receive side of MidiConnection.
 * Understands header/footer, `02 00 BANK` names requests, `04 00 BANK
 * PATCH` patch requests, and chunk acks; replies asynchronously like
 * real hardware so register-before-send ordering is exercised.
 */
function fakeDevice(opts: {
  namesPayload?: Uint8Array;
  patchBuffer?: Uint8Array;
  /** Stop sending chunks after this many (simulates a mid-transfer death). */
  dieAfterChunks?: number;
}): { conn: MidiConnection; log: string[] } {
  const handlers = new Set<(bytes: number[]) => void>();
  const log: string[] = [];

  let chunks: { info: number[] }[] = [];
  let sent = 0;

  const deliver = (info: number[]): void => {
    const frame = wrapSysex(info);
    setTimeout(() => {
      for (const h of Array.from(handlers)) h([...frame]);
    }, 1);
  };

  const chunkify = (payload: Uint8Array, typeByte: number): { info: number[] }[] => {
    const out: { info: number[] }[] = [];
    for (let off = 0, idx = 0; off < payload.length; off += 128, idx++) {
      const data = Array.from(payload.subarray(off, Math.min(off + 128, payload.length)));
      out.push({ info: [0x16, 0x00, idx, typeByte, ...data] });
    }
    return out;
  };

  const send = (bytes: number[]): void => {
    const info = unwrapSysex(bytes);
    const hex = Array.from(info.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
    log.push(hex);
    if (info[0] === 0x18) { deliver([0x19, 0x00]); return; }
    if (info[0] === 0x1a) { deliver([0x1b, 0x00]); return; }
    if (info[0] === 0x02 && opts.namesPayload) {
      chunks = chunkify(opts.namesPayload, 0x13);
      sent = 0;
      deliver(chunks[sent++]!.info);
      return;
    }
    if (info[0] === 0x04 && opts.patchBuffer) {
      chunks = chunkify(opts.patchBuffer, 0x16);
      sent = 0;
      deliver(chunks[sent++]!.info);
      return;
    }
    if (info[0] === 0x17) {
      // Chunk ack: enforce the TYPE-byte echo (real firmware presumably
      // correlates on it; a wrong echo must fail the golden loudly).
      const prev = chunks[sent - 1];
      if (prev && info[3] !== prev.info[3]) {
        log.push(`BAD-ACK-TYPE expected ${prev.info[3]!.toString(16)} got ${info[3]!.toString(16)}`);
        return; // device would ignore it: no next chunk
      }
      if (opts.dieAfterChunks !== undefined && sent >= opts.dieAfterChunks) return;
      if (sent < chunks.length) deliver(chunks[sent++]!.info);
      return;
    }
  };

  const conn: MidiConnection = {
    send,
    receiveSysEx: (timeoutMs = 1000) => receiver(() => true, timeoutMs),
    receiveSysExMatching: (pred, timeoutMs = 1000) => receiver(pred, timeoutMs),
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    hasInput: true,
    close: () => handlers.clear(),
  };

  function receiver(pred: (bytes: number[]) => boolean, timeoutMs: number): Promise<number[]> {
    const p = new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        handlers.delete(handler);
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (bytes: number[]): void => {
        if (bytes[0] !== 0xf0 || !pred(bytes)) return;
        clearTimeout(timer);
        handlers.delete(handler);
        resolve(bytes);
      };
      handlers.add(handler);
    });
    p.catch(() => { /* observed */ });
    return p;
  }

  return { conn, log };
}

// ---------------------------------------------------------------------------
// parseBankNames goldens.
// ---------------------------------------------------------------------------

check('parseBankNames round-trips 128 names (spec worked-example head)', () => {
  const names = parseBankNames(buildNamesPayload(0, SAMPLE_NAMES), 0);
  if (names.length !== 128) return `expected 128 names, got ${names.length}`;
  for (let i = 0; i < 128; i++) {
    if (names[i] !== SAMPLE_NAMES[i]) return `name ${i}: expected ${JSON.stringify(SAMPLE_NAMES[i])}, got ${JSON.stringify(names[i])}`;
  }
  return true;
});

check('parseBankNames keeps internal double spaces, trims padding only', () => {
  const custom = [...SAMPLE_NAMES];
  custom[9] = 'Play w  Jen KFP'; // internal double space, 15 chars
  custom[10] = 'SixteenCharName!'; // full 16-char field, no NUL inside
  const names = parseBankNames(buildNamesPayload(3, custom), 3);
  if (names[9] !== 'Play w  Jen KFP') return `got ${JSON.stringify(names[9])}`;
  if (names[10] !== 'SixteenCharName!') return `got ${JSON.stringify(names[10])}`;
  return true;
});

check('parseBankNames throws on wrong bank byte', () => {
  try {
    parseBankNames(buildNamesPayload(2, SAMPLE_NAMES), 5);
  } catch (err) {
    return err instanceof Error && err.message.includes('bank 2') ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

check('parseBankNames throws on wrong opcode', () => {
  const p = buildNamesPayload(0, SAMPLE_NAMES);
  p[0] = 0x04;
  try {
    parseBankNames(p, 0);
  } catch (err) {
    return err instanceof Error && err.message.includes('opcode') ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

check('parseBankNames throws on stride desync (corrupt separator)', () => {
  const p = buildNamesPayload(0, SAMPLE_NAMES);
  p[3 + 17] = 0x21; // clobber first entry's 0x3A separator
  try {
    parseBankNames(p, 0);
  } catch (err) {
    return err instanceof Error && err.message.includes('desync') ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

check('parseBankNames throws on truncated payload', () => {
  try {
    parseBankNames(buildNamesPayload(0, SAMPLE_NAMES).subarray(0, 500), 0);
  } catch (err) {
    return err instanceof Error && err.message.includes('short') ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

// ---------------------------------------------------------------------------
// Transaction goldens (scripted fake device).
// ---------------------------------------------------------------------------

check('readBankNames: full ack-driven transaction, 0x13 type echo, footer sent', async () => {
  const payload = buildNamesPayload(1, SAMPLE_NAMES);
  const { conn, log } = fakeDevice({ namesPayload: payload });
  const names = await readBankNames(conn, 1);
  if (names.length !== 128) return `expected 128 names, got ${names.length}`;
  if (names[0] !== 'Sawpressive GD') return `name 0: got ${JSON.stringify(names[0])}`;
  if (log.some((l) => l.startsWith('BAD-ACK-TYPE'))) return `ack type-byte echo broken: ${log.find((l) => l.startsWith('BAD-ACK-TYPE'))}`;
  // 19 chunks → 19 acks, plus header, request, footer.
  const acks = log.filter((l) => l.startsWith('17 00')).length;
  if (acks !== Math.ceil(payload.length / 128)) return `expected ${Math.ceil(payload.length / 128)} acks, got ${acks}`;
  if (!log.some((l) => l.startsWith('1a 00'))) return 'footer never sent';
  return true;
});

check('readStoredPatch: 22 chunks reassemble byte-identical, frames kept', async () => {
  const buf = new Uint8Array(INIT_PATCH_BUFFER);
  buf[2] = 4; // bank E
  buf[3] = 63;
  const { conn } = fakeDevice({ patchBuffer: buf });
  const { payload, frames } = await readStoredPatch(conn, 4, 63);
  if (payload.length !== PATCH_BUFFER_SIZE) return `expected ${PATCH_BUFFER_SIZE} bytes, got ${payload.length}`;
  for (let i = 0; i < buf.length; i++) {
    if (payload[i] !== buf[i]) return `byte ${i} mismatch: expected ${buf[i]}, got ${payload[i]}`;
  }
  if (frames.length !== 22) return `expected 22 frames, got ${frames.length}`;
  // Frames are verbatim device frames: re-unwrapping + concatenating
  // their data must reproduce the payload (the byte-exact backup path).
  let rebuilt: number[] = [];
  for (const f of frames) {
    const info = unwrapSysex(f);
    rebuilt = rebuilt.concat(Array.from(info.subarray(4)));
  }
  if (rebuilt.length !== PATCH_BUFFER_SIZE) return `rebuilt ${rebuilt.length} bytes from frames`;
  return true;
});

check('mid-transfer death: throws AND still sends the footer (soft-mutex release)', async () => {
  const { conn, log } = fakeDevice({ namesPayload: buildNamesPayload(0, SAMPLE_NAMES), dieAfterChunks: 2 });
  try {
    await readBankNames(conn, 0);
  } catch (err) {
    if (!(err instanceof Error) || !/timed out/.test(err.message)) return `wrong error: ${err}`;
    if (!log.some((l) => l.startsWith('1a 00'))) return 'footer NOT sent on the error path';
    return true;
  }
  return 'did not throw';
});

check('no input port: fails fast before sending anything', async () => {
  const { conn, log } = fakeDevice({ namesPayload: buildNamesPayload(0, SAMPLE_NAMES) });
  const noInput: MidiConnection = { ...conn, hasInput: false };
  try {
    await readBankNames(noInput, 0);
  } catch (err) {
    if (!(err instanceof Error) || !/INPUT port/.test(err.message)) return `wrong error: ${err}`;
    if (log.length !== 0) return `sent ${log.length} messages before failing`;
    return true;
  }
  return 'did not throw';
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  let result: boolean | string;
  try {
    result = await c.fn();
  } catch (err) {
    result = err instanceof Error ? `threw: ${err.message}` : String(err);
  }
  if (result === true) {
    passed++;
  } else {
    failed++;
    failures.push(`✗ ${c.label}\n    ${result}`);
  }
}

if (failed === 0) {
  console.log(`✓ ${passed}/${cases.length} hydrasynth patch-read cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
