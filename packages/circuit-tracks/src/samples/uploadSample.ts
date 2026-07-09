/**
 * Circuit Tracks SAMPLE upload driver.
 *
 * Bridges the WAV normalizer (wav.ts) and the pure frame plan
 * (sampleTransfer.ts) onto the wire via the SHARED, reboot-safe send loop
 * (`runUploadFramePlan` in ncs/uploadProject.ts) — the same hardened transport
 * the hardware-confirmed project upload uses (pre-flight liveness, per-send
 * abort, always-close). Replaces the manual Novation Components upload for a
 * single sample into one of the 64 drum-sample slots of the device's (internal-
 * flash) Pack.
 *
 * STATUS 2026-06-28 (post-review): The SOLID fix is the LOUD failure — SET_FILENAME
 * now carries an ACK expectation, so a rejection (the device replies 0x05 00…, not
 * 0x04) returns ok:false instead of the old acked-but-silent success. That, plus
 * disabling the destructive read_sample_directory, are the proven wins. The
 * PACK-INDEX theory (write the 0b 02 reply byte into frames) was REVERTED: the repo's
 * own _web/_our capture pair shows working Components writing pack byte 0 while its
 * 0b 02 reply reads 01, so the device does NOT copy that byte — the real
 * differentiator is empty-vs-occupied directory (still open; an empty non-default
 * pack still needs Components to initialize). The pack-2/pack-3 SD-card captures that
 * suggested the pack-index rule are confounded; needs a clean handshake on a 2+-pack
 * device with a known active index. Pack byte stays 0 (Components-proven). The
 * group-0x08 commit-wait theory stays REFUTED. See docs/design/circuit-sample-upload.md.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { runUploadFramePlan, type TransferOptions } from '../ncs/uploadProject.js';
import { buildKitUploadFrames, buildSampleUploadFrames, sampleBlockCount } from './sampleTransfer.js';
import { normalizeToDevice } from './wav.js';

// NOTE (2026-06-23): a post-CLOSE commit-wait (TransferOptions.awaitCommitMs) was
// added on the theory that the device's group-0x08 notification ~6-8s after CLOSE
// is the flash-commit gate. HARDWARE-REFUTED: the wait engages correctly (~6s) and
// receives that frame, but the slot STILL reads empty — the 0x08 frame is a generic
// "ready" status (the device sends it pre-write too), not commit-complete. So we do
// NOT engage awaitCommitMs by default; the opt-in mechanism + ingest fix remain for
// the eventual real fix. Root cause STILL OPEN. See docs/design/circuit-sample-upload.md.

export interface SampleUploadResult {
  ok: boolean;
  /** Destination sample slot, 0..63 (device shows 1..64). */
  slot: number;
  /** Number of WRITE_DATA blocks sent. */
  blocks: number;
  /** True when the source WAV was resampled/folded/requantized to 48k mono 16-bit. */
  converted: boolean;
  /** Filename written to the slot (what the device/Components shows). */
  filename: string;
  /** Human summary of the format step. */
  note: string;
  error?: string;
}

/**
 * Upload one WAV to drum-sample `slot` (0..63). The WAV is normalized to the
 * device's 48 kHz / mono / 16-bit format first (verbatim if it already matches).
 * Requires a bidirectional connection (the transfer is ACK-gated).
 */
export async function uploadSample(
  conn: MidiConnection, wavBytes: Uint8Array, slot: number, filename: string, opts: TransferOptions = {},
): Promise<SampleUploadResult> {
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
    throw new RangeError(`sample slot must be 0..63 (device 1..64), got ${slot}`);
  }
  const norm = normalizeToDevice(wavBytes);
  const blocks = sampleBlockCount(norm.wav.length);
  // Pack byte = 0 (Components-proven): the working Components capture writes 0x05 00
  // even when the 0b 02 reply reads 01, so the active-pack-index theory (write
  // reply[8]) is CONTRADICTED and was reverted (2026-06-28 review). The real
  // differentiator is empty-vs-occupied directory (still open). frame builder keeps
  // an opt-in packIndex param for the eventual proven path.
  const frames = buildSampleUploadFrames(norm.wav, slot, filename);
  // Components-faithful: open cold, send CLOSE exactly once (see TransferOptions.singleClose).
  const r = await runUploadFramePlan(conn, frames, { singleClose: true, ...opts });
  return {
    ok: r.ok, slot, blocks, converted: norm.converted, filename,
    note: norm.note, error: r.error,
  };
}

/** One uploaded item's outcome within a kit session. */
export interface KitItemResult { slot: number; filename: string; converted: boolean; blocks: number; }

/** Result of a single-session kit upload (all samples in one OPEN..CLOSE). */
export interface KitUploadResult {
  ok: boolean;
  /** The items the session wrote (all of them, since a kit is one atomic session). */
  uploaded: KitItemResult[];
  error?: string;
}

/**
 * Upload a whole kit in ONE sample-directory session (matches Components: a single
 * OPEN..CLOSE scoped to the 0x05 sample dir with the 64x 0x0d scan, via
 * buildKitUploadFrames). All-or-nothing: the session commits all samples or none.
 */
export async function uploadSampleKit(
  conn: MidiConnection,
  items: readonly { wav: Uint8Array; slot: number; filename: string }[],
  opts: TransferOptions = {},
): Promise<KitUploadResult> {
  if (items.length === 0) return { ok: false, uploaded: [], error: 'no samples to upload' };
  const norm = items.map((it) => {
    const n = normalizeToDevice(it.wav);
    return { wav: n.wav, slot: it.slot, filename: it.filename, converted: n.converted, blocks: sampleBlockCount(n.wav.length) };
  });
  // Pack byte 0 (Components-proven); active-pack-index derivation reverted, see uploadSample above.
  const frames = buildKitUploadFrames(norm.map((n) => ({ wav: n.wav, slot: n.slot, filename: n.filename })));
  const r = await runUploadFramePlan(conn, frames, { singleClose: true, ...opts });
  return {
    ok: r.ok,
    uploaded: r.ok ? norm.map((n) => ({ slot: n.slot, filename: n.filename, converted: n.converted, blocks: n.blocks })) : [],
    error: r.error,
  };
}
