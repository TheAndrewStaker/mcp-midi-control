/**
 * Verified gen-3 edit-buffer load: send the dump (presetDumpSend.ts), read
 * the edit buffer back (presetDumpRead.ts) and compare word for word
 * (presetDumpCompare.ts). If the unit did not take it, wait 1 s and send it
 * ONCE more: fractone (MIT, FM9 fw 12, 2026-10-13) saw the FM9 drop a dump
 * that arrived while it was still loading the preset just selected, the
 * buffer keeping the stored preset (Fm9StoredPresetReplacer.AuditionAsync).
 *
 * The read-back compare is the JUDGE on every model: on FM3 / Axe-Fx III the
 * per-frame ack is unevidenced (presetDumpSend.ts 'probe' policy), so an
 * un-acked load counts only when the read-back holds what was sent.
 *
 * Refuses before sending: a dump whose raw patch does not decode, or an
 * ERASED stored slot (raw patch all 0xFF; ForgeFX docs/preset-grid-codec.md),
 * which is not a preset and must never be loaded.
 *
 * Community-beta, untested by us. Expect roughly 1-3 s on FM9 / FM3 (8 chunk
 * frames, the 300 ms settle and a full dump read-back) and more on the III
 * (16 chunks) or when the resend runs: callers must announce it. One overall
 * deadline (default 25 s) bounds the whole call.
 */
import { loadPresetDumpToEditBuffer } from './presetDumpSend.js';
import type { DumpTransferConnection, EditBufferLoadOptions, EditBufferLoadResult } from './presetDumpSend.js';
import { readEditBufferPresetDump, PRESET_DUMP_READ_TIMEOUT_MS } from './presetDumpRead.js';
import { comparePresetDumps } from './presetDumpCompare.js';
import type { PresetDumpCompareResult } from './presetDumpCompare.js';
import type { ParsedPresetDump } from './presetDump.js';
import { decode3to16, decodeRawPatch } from './presetHuffman.js';

export const DROPPED_LOAD_RESEND_DELAY_MS = 1000;
export const VERIFIED_LOAD_DEADLINE_MS = 25_000;

export interface VerifiedLoadOptions extends EditBufferLoadOptions {
  readTimeoutMs?: number;
  deviceLabel?: string;
  /** Overall ceiling for send + read-back + resend (default 25 s). */
  overallDeadlineMs?: number;
}

export interface VerifiedLoadResult {
  /** The edit buffer holds the preset sent (identical or only recalculated words differ). */
  ok: boolean;
  /** Transfer results, one per send (two when the resend ran). */
  sends: EditBufferLoadResult[];
  /** True when the first load was dropped and the second was sent. */
  resent: boolean;
  /** The last compare, when a read-back happened. */
  compare?: PresetDumpCompareResult;
  /** The last edit-buffer read-back, when one happened. */
  read_back?: ParsedPresetDump;
  /** Why a read-back failed (timeout / malformed), when it did. */
  read_error?: string;
  /** Set when the dump was refused before anything was sent. */
  refused?: string;
  elapsed_ms: number;
}

/** Why a dump must not be loaded, or undefined when it may. */
export function refuseDumpForLoad(dump: ParsedPresetDump): string | undefined {
  // Unpack first (no Huffman): an erased slot's 0xFF size words would not decompress.
  let total = 0;
  for (const c of dump.chunkPayloads) total += c.length - 2;
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of dump.chunkPayloads) { packed.set(c.subarray(2), off); off += c.length - 2; }
  const raw = decode3to16(packed);
  if (raw.length > 0 && raw.every((b) => b === 0xff)) return 'the dump is an ERASED preset slot (raw patch all 0xFF)';
  try {
    const d = decodeRawPatch(dump.chunkPayloads);
    if (!d.crcValid) return 'the dump\'s raw-patch CRC is invalid';
  } catch (err) {
    return `the dump's raw patch does not decode (${err instanceof Error ? err.message : String(err)})`;
  }
  return undefined;
}

async function readAndCompare(
  conn: DumpTransferConnection,
  modelByte: number,
  dump: ParsedPresetDump,
  label: string,
  timeoutMs: number,
): Promise<{ compare?: PresetDumpCompareResult; read_back?: ParsedPresetDump; read_error?: string }> {
  try {
    const read_back = await readEditBufferPresetDump(conn, modelByte, label, timeoutMs);
    return { read_back, compare: comparePresetDumps(dump, read_back) };
  } catch (err) {
    return { read_error: err instanceof Error ? err.message : String(err) };
  }
}

/** Load `dump` into the edit buffer and prove it landed. Never stores. */
export async function loadPresetDumpVerified(
  conn: DumpTransferConnection,
  modelByte: number,
  dump: ParsedPresetDump,
  opts: VerifiedLoadOptions = {},
): Promise<VerifiedLoadResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  const label = opts.deviceLabel ?? `model 0x${modelByte.toString(16)}`;
  const deadline = opts.overallDeadlineMs ?? VERIFIED_LOAD_DEADLINE_MS;
  const remaining = (): number => Math.max(1, deadline - (now() - started));
  const readTimeoutMs = (): number => Math.min(opts.readTimeoutMs ?? PRESET_DUMP_READ_TIMEOUT_MS, remaining());
  const sends: EditBufferLoadResult[] = [];
  const done = (r: Omit<VerifiedLoadResult, 'elapsed_ms' | 'sends'>): VerifiedLoadResult => ({ ...r, sends, elapsed_ms: now() - started });

  const refused = refuseDumpForLoad(dump);
  if (refused !== undefined) return done({ ok: false, resent: false, refused });

  const first = await loadPresetDumpToEditBuffer(conn, modelByte, dump, { ...opts, deadlineMs: Math.min(opts.deadlineMs ?? remaining(), remaining()) });
  sends.push(first);
  if (!first.ok) return done({ ok: false, resent: false });
  let check = await readAndCompare(conn, modelByte, dump, label, readTimeoutMs());
  if (check.compare?.holds) return done({ ok: true, resent: false, ...check });
  if (check.read_error !== undefined) return done({ ok: false, resent: false, ...check });
  if (remaining() <= DROPPED_LOAD_RESEND_DELAY_MS) return done({ ok: false, resent: false, ...check });

  // The unit took every frame but holds something else: resend once.
  await sleep(DROPPED_LOAD_RESEND_DELAY_MS);
  const second = await loadPresetDumpToEditBuffer(conn, modelByte, dump, { ...opts, deadlineMs: remaining() });
  sends.push(second);
  if (!second.ok) return done({ ok: false, resent: true, ...check });
  check = await readAndCompare(conn, modelByte, dump, label, readTimeoutMs());
  return done({ ok: check.compare?.holds === true, resent: true, ...check });
}
