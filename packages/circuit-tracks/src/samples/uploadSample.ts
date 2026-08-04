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
 * group-0x08 commit-wait theory stays REFUTED. See docs/design/circuit-sample-upload.md.
 *
 * PACK ADDRESSING (2026-07-17): the fileId middle byte is the 0-based pack, a byte
 * the caller CHOOSES — hardware-confirmed 2026-07-16 for projects/patches
 * (`docs/design/circuit-pack-addressing.md`), and the sample write uses the identical
 * fileId shape. `packIndex` is now threaded from ctx.pack so a sample upload lands on
 * the SAME pack the project targets (closing the cross-pack name-mismatch trap). This
 * supersedes the reverted 2026-06-28 "active-pack-index the device REPORTS" theory:
 * that was about the device reporting a pack (the `0b 02` byte, which is a COUNT); the
 * decode shows the byte is chosen. Pack 0 works, and the NONZERO-pack sample
 * write is HARDWARE-CONFIRMED as of 2026-07-27 (below).
 *
 * NONZERO-PACK WRITE CONFIRMED 2026-07-27 (`scripts/circuit-clone-pack-samples.ts`,
 * maintainer's 2-pack device). Pack 1's 64 slots were read off the DEVICE, each
 * download gated by the device's own CRC32, and 63 of them written to Pack 2
 * (the 64th was already byte-identical). Index alignment was PROVEN, not
 * assumed: wire slot 0 was written alone, then wire slot 63 written SECOND and
 * out of order, and it landed at 63 rather than at the next free index, so the
 * slot byte is ADDRESSED, not append-ordered. Eight slots spread across the pool
 * were then downloaded back off Pack 2 md5-identical to the Pack 1 originals,
 * and a full 64-slot name diff came back identical. Not separately re-checked
 * across a power-cycle: the evidence is a device read-back, not a reboot.
 *
 * THE READ-BACK RACES THE FLASH COMMIT. The device flushes a pack's sample
 * manifest ~6-8 s AFTER the session CLOSES. A pool read 1.2 s later reported 8
 * slots empty that a later read showed present; nothing had been lost, the check
 * was simply too fast. Verify by POLLING (reconnect, ~9 s, then 5 s retries),
 * never off one immediate read. This does NOT revive the refuted commit-wait
 * theory noted below: that was about waiting IN-session on a group-0x08 frame as
 * a commit signal (still refuted, that frame is a generic "ready"). This is
 * about when a verification read becomes admissible, with the session already
 * closed. On a device with no erase, a false "the write failed" is expensive.
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
  conn: MidiConnection, wavBytes: Uint8Array, slot: number, filename: string,
  opts: TransferOptions & { packIndex?: number } = {},
): Promise<SampleUploadResult> {
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
    throw new RangeError(`sample slot must be 0..63 (device 1..64), got ${slot}`);
  }
  const packIndex = opts.packIndex ?? 0;
  const norm = normalizeToDevice(wavBytes);
  const blocks = sampleBlockCount(norm.wav.length);
  // The fileId middle byte is the 0-based PACK, a byte the caller CHOOSES
  // (`docs/design/circuit-pack-addressing.md`, hardware-confirmed 2026-07-16 for
  // projects/patches; the sample write uses the identical fileId shape). Threaded
  // from ctx.pack so an upload lands on the SAME pack the project targets, instead
  // of always Pack 1. The earlier "active-pack-index the device reports" theory —
  // reverted 2026-06-28 — was about the device REPORTING a pack; the decode shows
  // the byte is chosen, not reported. Pack 0 works, and a nonzero pack is
  // hardware-confirmed too (2026-07-27 clone onto Pack 2; module docstring).
  const frames = buildSampleUploadFrames(norm.wav, slot, filename, { packIndex });
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
  opts: TransferOptions & { packIndex?: number } = {},
): Promise<KitUploadResult> {
  if (items.length === 0) return { ok: false, uploaded: [], error: 'no samples to upload' };
  const packIndex = opts.packIndex ?? 0;
  const norm = items.map((it) => {
    const n = normalizeToDevice(it.wav);
    return { wav: n.wav, slot: it.slot, filename: it.filename, converted: n.converted, blocks: sampleBlockCount(n.wav.length) };
  });
  // Pack threaded from ctx.pack (see uploadSample above): all samples in the kit
  // land on the chosen pack, the same one the project targets.
  const frames = buildKitUploadFrames(norm.map((n) => ({ wav: n.wav, slot: n.slot, filename: n.filename })), { packIndex });
  const r = await runUploadFramePlan(conn, frames, { singleClose: true, ...opts });
  return {
    ok: r.ok,
    uploaded: r.ok ? norm.map((n) => ({ slot: n.slot, filename: n.filename, converted: n.converted, blocks: n.blocks })) : [],
    error: r.error,
  };
}
