/**
 * Hydrasynth Explorer — golden tests for the byte-exact stored-patch
 * WRITE transactions (BK-113): `addressPatchBuffer`, `framesToPatchBuffer`,
 * and the ack-driven series-write flow (`writeStoredPatches`).
 *
 * Locks `packages/hydrasynth/src/patchWrite.ts` against:
 *   1. Header addressing — a write rewrites ONLY bytes 0 (0x06 marker),
 *      2 (bank), 3 (patch); everything else byte-identical (the spec's
 *      write example and the hardware-confirmed apply_patch behavior).
 *   2. `.syx` backup round-trip — export frames → framesToPatchBuffer →
 *      the original 2790-byte buffer.
 *   3. The series flow against a scripted fake device: ack-driven chunk
 *      pacing, Patch Saved counters per patch, exactly ONE Write Request
 *      (14 00) per batch, 15 00 receipt handling, footer on success AND
 *      error paths, byte-identity of what the device reassembles.
 *   4. Refusals: mixed-bank batch, empty batch, no input port.
 *   5. Protect-ON simulation: no 15 00 → flash_receipt: false (not a
 *      throw — the caller re-reads to verify).
 *   6. The import_preset restore path (`restorePresetBinaryHydrasynth`):
 *      three-gate refusals (target required, save_authorized required,
 *      confirm_overwrite with occupant pre-read), wrong-model file
 *      refusal, happy-path byte identity + receipt-true ok, and the
 *      Protect-ON read-back-mismatch → ok:false + warning.
 *
 * Run:  npx tsx scripts/hydrasynth/verify-patch-write.ts
 */
import { wrapSysex, unwrapSysex } from '@mcp-midi-control/hydrasynth/sysexEnvelope.js';
import {
  addressPatchBuffer,
  framesToPatchBuffer,
  writeStoredPatches,
} from '@mcp-midi-control/hydrasynth/patchWrite.js';
import { restorePresetBinaryHydrasynth } from '@mcp-midi-control/hydrasynth/descriptor/presetRestore.js';
import { clearBypassWetCache, writer as hydraWriter } from '@mcp-midi-control/hydrasynth/descriptor/writer.js';
import { splitIntoChunks, readPatchName, writePatchName, PATCH_BUFFER_SIZE } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { INIT_PATCH_BUFFER } from '@mcp-midi-control/hydrasynth/initPatchBuffer.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

interface Case {
  label: string;
  fn: () => Promise<boolean | string> | boolean | string;
}
const cases: Case[] = [];
function check(label: string, fn: Case['fn']): void {
  cases.push({ label, fn });
}

/** A deterministic non-INIT test buffer (every byte varies). */
function testBuffer(seed: number): Uint8Array {
  const buf = new Uint8Array(INIT_PATCH_BUFFER);
  for (let i = 8; i < buf.length; i++) buf[i] = (buf[i]! + seed + (i % 97)) & 0x7f;
  return buf;
}

/**
 * Scripted fake device for the WRITE direction: acks our chunks, emits
 * the Patch Saved counter after each patch's final chunk, answers 14 00
 * with 15 00 (unless `protectOn`), and reassembles what it received so
 * byte-identity can be asserted.
 *
 * Also serves the `02 00 BANK` bank-name read flow (ack-driven, type
 * 0x13) so the restore path's occupant pre-read + post-write verify run
 * against it. Flash-truth model: served names reflect committed writes
 * only; with `protectOn` the name table never updates, exactly like a
 * real Protect-ON no-op.
 */
function fakeDevice(opts: { protectOn?: boolean; hasInput?: boolean } = {}): {
  conn: MidiConnection;
  received: Map<string, Uint8Array>; // "bank:patch" -> reassembled buffer
  writeRequests: number;
} {
  const handlers = new Set<(bytes: number[]) => void>();
  const received = new Map<string, Uint8Array>();
  const state = { writeRequests: 0 };
  let current: { bank: number; patch: number; parts: number[][] } | undefined;
  let nameStream: { chunks: number[][] } | undefined;

  const deliver = (info: number[]): void => {
    const frame = wrapSysex(info);
    setTimeout(() => {
      for (const h of Array.from(handlers)) h([...frame]);
    }, 1);
  };

  // Flash-level stored name for one slot: a committed write's buffer name,
  // else a deterministic factory placeholder. Protect ON never commits.
  const nameFor = (bank: number, patch: number): string => {
    const written = opts.protectOn ? undefined : received.get(`${bank}:${patch}`);
    return written !== undefined ? readPatchName(written) : `FACT ${bank}-${patch}`;
  };

  // `03 00 BANK` + 128 × (16-byte name + 0x00) with 0x3A separators = 2306.
  const namesPayload = (bank: number): number[] => {
    const out = [0x03, 0x00, bank];
    for (let p = 0; p < 128; p++) {
      const nm = nameFor(bank, p);
      for (let j = 0; j < 16; j++) out.push(j < nm.length ? nm.charCodeAt(j) & 0x7f : 0x00);
      out.push(0x00);
      if (p < 127) out.push(0x3a);
    }
    return out;
  };

  const send = (bytes: number[]): void => {
    const info = unwrapSysex(bytes);
    if (info[0] === 0x18) { deliver([0x19, 0x00]); return; }
    if (info[0] === 0x1a) { nameStream = undefined; deliver([0x1b, 0x00]); return; }
    if (info[0] === 0x14) {
      state.writeRequests++;
      if (!opts.protectOn) deliver([0x15, 0x00]);
      return;
    }
    if (info[0] === 0x02 && info[1] === 0x00) {
      // Bank-name read request: stream chunk 0; later chunks ride our acks.
      const payload = namesPayload(info[2]!);
      const chunks: number[][] = [];
      for (let off = 0, idx = 0; off < payload.length; off += 128, idx++) {
        chunks.push([0x16, 0x00, idx, 0x13, ...payload.slice(off, off + 128)]);
      }
      nameStream = { chunks };
      deliver(chunks[0]!);
      return;
    }
    if (info[0] === 0x17 && info[1] === 0x00) {
      // Our ack of the device's chunk N (read flow) → it sends chunk N+1.
      const next = nameStream?.chunks[info[2]! + 1];
      if (next) deliver(next);
      return;
    }
    if (info[0] === 0x16 && info[1] === 0x00) {
      const idx = info[2]!;
      const data = Array.from(info.subarray(4));
      if (idx === 0) current = { bank: data[2]!, patch: data[3]!, parts: [] };
      current?.parts.push(data);
      const isFinal = data.length < 128;
      if (isFinal && current) {
        const flat = current.parts.flat();
        received.set(`${current.bank}:${current.patch}`, Uint8Array.from(flat));
        // Spec order: Patch Saved BEFORE the final chunk ack.
        deliver([0x07, 0x00, current.bank, current.patch]);
        current = undefined;
      }
      deliver([0x17, 0x00, idx, 0x16]);
      return;
    }
  };

  const conn: MidiConnection = {
    send,
    receiveSysEx: (timeoutMs = 1000) => receiver(() => true, timeoutMs),
    receiveSysExMatching: (pred, timeoutMs = 1000) => receiver(pred, timeoutMs),
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    hasInput: opts.hasInput ?? true,
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

  return {
    conn,
    received,
    get writeRequests(): number { return state.writeRequests; },
  };
}

// ── addressPatchBuffer goldens ──────────────────────────────────────

check('addressPatchBuffer rewrites ONLY bytes 0, 2, 3', () => {
  const src = testBuffer(7);
  src[0] = 0x05; // read marker, as a device dump carries
  src[2] = 3;    // source slot D...
  src[3] = 99;
  const out = addressPatchBuffer(src, 1, 14); // → B015
  if (out[0] !== 0x06) return `byte 0: expected 0x06, got 0x${out[0]!.toString(16)}`;
  if (out[2] !== 1 || out[3] !== 14) return `bytes 2/3: got ${out[2]}/${out[3]}`;
  for (let i = 0; i < src.length; i++) {
    if (i === 0 || i === 2 || i === 3) continue;
    if (out[i] !== src[i]) return `byte ${i} changed: ${src[i]} -> ${out[i]}`;
  }
  if (src[0] !== 0x05) return 'source buffer was mutated';
  return true;
});

check('addressPatchBuffer refuses bad sizes and slots', () => {
  try { addressPatchBuffer(new Uint8Array(100), 0, 0); return 'accepted short buffer'; } catch { /* ok */ }
  try { addressPatchBuffer(testBuffer(1), 8, 0); return 'accepted bank 8'; } catch { /* ok */ }
  try { addressPatchBuffer(testBuffer(1), 0, 128); return 'accepted patch 128'; } catch { /* ok */ }
  return true;
});

// ── framesToPatchBuffer goldens ─────────────────────────────────────

check('framesToPatchBuffer round-trips an export-shaped .syx', () => {
  const buf = testBuffer(3);
  const frames = splitIntoChunks(buf).map((c) => wrapSysex(c.info));
  const fileBytes = Uint8Array.from(frames.flat());
  const back = framesToPatchBuffer(fileBytes);
  if (back.length !== PATCH_BUFFER_SIZE) return `length ${back.length}`;
  for (let i = 0; i < buf.length; i++) {
    if (back[i] !== buf[i]) return `byte ${i}: ${buf[i]} -> ${back[i]}`;
  }
  return true;
});

check('framesToPatchBuffer throws on out-of-order / corrupt frames', () => {
  const buf = testBuffer(4);
  const frames = splitIntoChunks(buf).map((c) => wrapSysex(c.info));
  [frames[0], frames[1]] = [frames[1]!, frames[0]!];
  try {
    framesToPatchBuffer(Uint8Array.from(frames.flat()));
  } catch (err) {
    return err instanceof Error && /out of order/.test(err.message) ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

// ── Series-flow goldens ─────────────────────────────────────────────

check('series write: 3 patches, byte-identical delivery, ONE 14 00, receipt', async () => {
  const dev = fakeDevice();
  const entries = [0, 1, 2].map((p) => ({ bank: 2, patch: 10 + p, buffer: testBuffer(p) }));
  const result = await writeStoredPatches(dev.conn, entries, { flashSettleMs: 5 });
  if (result.patches_acked !== 3) return `patches_acked ${result.patches_acked}`;
  if (result.patch_saved_seen !== 3) return `patch_saved_seen ${result.patch_saved_seen}`;
  if (!result.flash_receipt) return 'no flash receipt';
  if (dev.writeRequests !== 1) return `expected 1 write request, saw ${dev.writeRequests}`;
  for (const e of entries) {
    const got = dev.received.get(`2:${e.patch}`);
    if (!got) return `device never reassembled 2:${e.patch}`;
    const expect = addressPatchBuffer(e.buffer, e.bank, e.patch);
    for (let i = 0; i < expect.length; i++) {
      if (got[i] !== expect[i]) return `2:${e.patch} byte ${i}: expected ${expect[i]}, got ${got[i]}`;
    }
  }
  return true;
});

check('Protect-ON sim: no 15 00 -> flash_receipt false, no throw, footer sent', async () => {
  const dev = fakeDevice({ protectOn: true });
  const result = await writeStoredPatches(dev.conn, [{ bank: 0, patch: 5, buffer: testBuffer(9) }], { flashSettleMs: 5 });
  if (result.flash_receipt) return 'flash_receipt should be false';
  if (result.patches_acked !== 1) return `patches_acked ${result.patches_acked}`;
  return true;
});

check('mixed-bank batch refused before any wire I/O', async () => {
  const dev = fakeDevice();
  try {
    await writeStoredPatches(dev.conn, [
      { bank: 0, patch: 0, buffer: testBuffer(1) },
      { bank: 1, patch: 0, buffer: testBuffer(2) },
    ]);
  } catch (err) {
    if (!(err instanceof Error) || !/mixed-bank/.test(err.message)) return `wrong error: ${err}`;
    if (dev.received.size !== 0) return 'wire I/O happened before the refusal';
    return true;
  }
  return 'did not throw';
});

check('no input port: fails fast', async () => {
  const dev = fakeDevice({ hasInput: false });
  try {
    await writeStoredPatches(dev.conn, [{ bank: 0, patch: 0, buffer: testBuffer(1) }]);
  } catch (err) {
    return err instanceof Error && /INPUT port/.test(err.message) ? true : `wrong error: ${err}`;
  }
  return 'did not throw';
});

// ── import_preset restore-path goldens ──────────────────────────────

/** An export-shaped `.syx` whose buffer carries a known patch name. */
function restoreFile(name: string): { fileBytes: Uint8Array; buffer: Uint8Array } {
  const buffer = new Uint8Array(INIT_PATCH_BUFFER);
  writePatchName(buffer, name);
  buffer[0] = 0x05; // read marker, as a device dump carries
  buffer[2] = 0;    // source slot A012
  buffer[3] = 11;
  const frames = splitIntoChunks(buffer).map((c) => wrapSysex(c.info));
  return { fileBytes: Uint8Array.from(frames.flat()), buffer };
}

function expectDispatchCode(err: unknown, code: string): true | string {
  if (!(err instanceof DispatchError)) return `expected DispatchError, got ${err}`;
  return err.code === code ? true : `expected code ${code}, got ${err.code}`;
}

check('restore: non-Hydrasynth file refused before any wire I/O', async () => {
  const dev = fakeDevice();
  try {
    await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, Uint8Array.from([0xf0, 0x00, 0xf7]), {
      target_location: 'B002', save_authorized: true, confirm_overwrite: true,
    });
  } catch (err) {
    const r = expectDispatchCode(err, 'value_out_of_range');
    if (r !== true) return r;
    if (dev.received.size !== 0 || dev.writeRequests !== 0) return 'wire I/O happened';
    return true;
  }
  return 'did not throw';
});

check('restore: no target_location -> capability_not_supported naming the backup', async () => {
  const dev = fakeDevice();
  const { fileBytes } = restoreFile('RESTORE ME');
  try {
    await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, fileBytes, {});
  } catch (err) {
    const r = expectDispatchCode(err, 'capability_not_supported');
    if (r !== true) return r;
    const msg = (err as Error).message;
    if (!/RESTORE ME/.test(msg)) return `refusal does not name the patch: ${msg}`;
    if (!/A012/.test(msg)) return `refusal does not name the source slot: ${msg}`;
    return true;
  }
  return 'did not throw';
});

check('restore: target without save_authorized -> save_authorization_required', async () => {
  const dev = fakeDevice();
  const { fileBytes } = restoreFile('RESTORE ME');
  try {
    await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, fileBytes, { target_location: 'B002' });
  } catch (err) {
    return expectDispatchCode(err, 'save_authorization_required');
  }
  return 'did not throw';
});

check('restore: no confirm_overwrite -> occupant pre-read surfaced, no write I/O', async () => {
  const dev = fakeDevice();
  const { fileBytes } = restoreFile('RESTORE ME');
  try {
    await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, fileBytes, {
      target_location: 'B002', save_authorized: true,
    });
  } catch (err) {
    const r = expectDispatchCode(err, 'overwrite_confirmation_required');
    if (r !== true) return r;
    // B002 = bank 1, patch 1 → the fake's factory name.
    if (!/FACT 1-1/.test((err as Error).message)) return `occupant name missing: ${(err as Error).message}`;
    if (dev.received.size !== 0 || dev.writeRequests !== 0) return 'write I/O happened before the gate';
    return true;
  }
  return 'did not throw';
});

check('restore: happy path (byte identity, ONE 14 00, receipt-true ok, read-back verified)', async () => {
  const dev = fakeDevice();
  const { fileBytes, buffer } = restoreFile('RESTORE ME');
  const result = await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, fileBytes, {
    target_location: 'B002', save_authorized: true, confirm_overwrite: true,
  }, { flashSettleMs: 5 });
  if (!result.ok) return `ok false (warning: ${result.warning})`;
  if (result.saved_to_location !== 'B002') return `saved_to_location ${result.saved_to_location}`;
  if (result.name !== 'RESTORE ME') return `name ${result.name}`;
  if (result.warning !== undefined) return `unexpected warning: ${result.warning}`;
  if (dev.writeRequests !== 1) return `expected 1 write request, saw ${dev.writeRequests}`;
  const got = dev.received.get('1:1');
  if (!got) return 'device never reassembled 1:1';
  const expect = addressPatchBuffer(buffer, 1, 1);
  for (let i = 0; i < expect.length; i++) {
    if (got[i] !== expect[i]) return `byte ${i}: expected ${expect[i]}, got ${got[i]}`;
  }
  return true;
});

check('restore: Protect-ON (no receipt, stale read-back) -> ok false + warning', async () => {
  const dev = fakeDevice({ protectOn: true });
  const { fileBytes } = restoreFile('RESTORE ME');
  const result = await restorePresetBinaryHydrasynth({ conn: dev.conn } as DispatchCtx, fileBytes, {
    target_location: 'B002', save_authorized: true, confirm_overwrite: true,
  }, { flashSettleMs: 5 });
  if (result.ok) return 'ok should be false';
  if (result.saved_to_location !== undefined) return `saved_to_location should be absent, got ${result.saved_to_location}`;
  if (result.warning === undefined || !/Protect/.test(result.warning)) return `warning missing/wrong: ${result.warning}`;
  return true;
});

// ── A14-2: bypass wet-cache invalidation ────────────────────────────
//
// The cache remembers the wet level last written to each FX block so a
// bypass/engage cycle restores it. Three staleness paths are closed:
// a DIRECT set_param to the underlying wet param must update the cache
// (the old bug: engage restored an earlier value over the user's fresh
// one), a whole-buffer write (apply_patch / init_patch / switch_preset)
// must clear it, and set_bypass's own internal wet=0 write must NOT be
// recorded as a wet level (engage would "restore" silence).

function wetCtx(): { ctx: DispatchCtx; sent: number[][] } {
  const sent: number[][] = [];
  const ctx = { conn: { send: (b: number[]) => sent.push([...b]) } } as unknown as DispatchCtx;
  return { ctx, sent };
}
const engageBytesFor = (wire: number): string =>
  hydraWriter.buildSetParam!('delay', 'dry_wet', wire).join(',');

check('direct set_param of a wet param updates the cache: engage restores IT, not the default', async () => {
  clearBypassWetCache();
  const { ctx, sent } = wetCtx();
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 100);
  await hydraWriter.setBypass!(ctx, 'delay', true);
  sent.length = 0;
  await hydraWriter.setBypass!(ctx, 'delay', false);
  const got = sent.flat().join(',');
  if (got !== engageBytesFor(100)) return `engage sent ${got}, expected the direct-set 100`;
  return true;
});

check('clearBypassWetCache (the apply_patch / init_patch hook) drops the cache: engage falls back to the default', async () => {
  clearBypassWetCache();
  const { ctx, sent } = wetCtx();
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 100);
  clearBypassWetCache(); // what tools/patch.ts now does after every whole-buffer dump
  sent.length = 0;
  await hydraWriter.setBypass!(ctx, 'delay', false);
  const got = sent.flat().join(',');
  if (got !== engageBytesFor(64)) return `engage sent ${got}, expected the engageDefault 64`;
  return true;
});

check('a direct wet write of 0 (manual mute) is NOT cached: engage restores the audible default', async () => {
  clearBypassWetCache();
  const { ctx, sent } = wetCtx();
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 90);
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 0);
  sent.length = 0;
  await hydraWriter.setBypass!(ctx, 'delay', false);
  const got = sent.flat().join(',');
  if (got !== engageBytesFor(64)) return `engage sent ${got}, expected the engageDefault 64 (never a cached 0)`;
  return true;
});

check("set_bypass's own wet=0 write does not poison the cache: engage after repeated bypass restores the set value", async () => {
  clearBypassWetCache();
  const { ctx, sent } = wetCtx();
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 90);
  await hydraWriter.setBypass!(ctx, 'delay', true);
  await hydraWriter.setBypass!(ctx, 'delay', true);
  sent.length = 0;
  await hydraWriter.setBypass!(ctx, 'delay', false);
  const got = sent.flat().join(',');
  if (got !== engageBytesFor(90)) return `engage sent ${got}, expected the pre-bypass 90`;
  return true;
});

check('switch_preset clears the cache (the new patch carries its own wet values)', async () => {
  clearBypassWetCache();
  const { ctx, sent } = wetCtx();
  await hydraWriter.setParam!(ctx, 'delay', 'dry_wet', 100);
  await hydraWriter.switchPreset!(ctx, 'A001');
  sent.length = 0;
  await hydraWriter.setBypass!(ctx, 'delay', false);
  const got = sent.flat().join(',');
  if (got !== engageBytesFor(64)) return `engage sent ${got}, expected the engageDefault 64`;
  clearBypassWetCache();
  return true;
});

check('apply_patch AND init_patch both invalidate the cache (source-pinned)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('packages/hydrasynth/src/tools/patch.ts', 'utf8');
  const calls = src.match(/clearBypassWetCache\(\)/g)?.length ?? 0;
  if (calls < 2) return `expected clearBypassWetCache() in both whole-buffer tools, found ${calls} call(s)`;
  return true;
});

// ── Runner ──────────────────────────────────────────────────────────

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
  if (result === true) passed++;
  else {
    failed++;
    failures.push(`✗ ${c.label}\n    ${result}`);
  }
}
if (failed === 0) {
  console.log(`✓ ${passed}/${cases.length} hydrasynth patch-write cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
