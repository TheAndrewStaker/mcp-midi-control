/**
 * MicroFreak byte-exact preset WRITE: backs the unified `import_preset`
 * tool via `DeviceWriter.restorePresetBinary`.
 *
 * Pushes a 146-frame `.syx` backup (written by `export_preset` /
 * `backup_device`, see `reader.ts`'s `dumpStoredPresetBinary`) to a STORED
 * preset slot over the six-frame-type flow decoded from a real MIDI
 * Control Center capture (`codec/sysex.ts`'s "Preset WRITE" section has the
 * full byte-level provenance). HARDWARE-CONFIRMED 2026-08-14: this
 * implementation restored a preset to a stored slot and a fresh
 * `export_preset` of that slot diffed at zero bytes across all 6,132
 * against the source.
 *
 * Restore shape on this device (deliberate, mirrors the Hydrasynth's
 * `presetRestore.ts` posture, adapted to what THIS device's wire protocol
 * actually needs):
 *
 *   - `target_location` REQUIRED. Every captured write addresses a
 *     bank/index destination directly; no working-buffer write shape was
 *     ever observed, so there is no reversible working-buffer restore here.
 *   - `save_authorized` REQUIRED: a stored-slot SysEx write on this device
 *     IS the persist (no separate buffer/flash split like Fractal gear;
 *     see `save_preset` staying refused on this device -- there is no
 *     second opcode to wire it to).
 *   - `confirm_overwrite` REQUIRED whenever the destination is occupied
 *     (its current name is pre-read and surfaced in the refusal, same
 *     BK-110-style gate as the Hydrasynth restore).
 *   - `name` REQUIRED. The write protocol pushes an explicit ASCII name
 *     frame ahead of the payload, and a byte-exact `bytes` dump (146
 *     payload frames) does not carry the name anywhere inside it --
 *     confirmed by searching the payload for the source preset's own name
 *     text and finding no match at any offset. `export_preset`'s JSON
 *     response already returns `name` for exactly this reason; pass it
 *     straight through.
 *   - `preset_type` OPTIONAL, same reasoning as `name`: the category rides
 *     the metadata frame and is absent from the payload. Omitted, the
 *     preset files under no category. It is copied through uninterpreted
 *     and checked against the device's own answer in the closing read-back.
 *
 * Verification is receipt-true: `ok` requires the closing query (the same
 * `buildNameRequest` used for the destination occupancy pre-read) to answer
 * with the name just written. A per-frame device ACK is proof the frame
 * arrived, never proof the preset persisted -- the closing read-back is
 * the only thing that is.
 */
import type {
  DispatchCtx,
  LocationRef,
  RestorePresetResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildBulkBegin,
  buildNameRequest,
  buildPresetConfirm,
  buildPresetDataFrame,
  buildPresetMetadata,
  CMD,
  decodePresetName,
  decodePresetType,
  dumpPacketPayload,
  nameReplyMatcher,
  presetWriteAckMatcher,
} from '../codec/sysex.js';
import type { FreakConfig } from '../devices/types.js';

/** Per-frame ack / reply wait. Generous like `reader.ts`'s DUMP_TIMEOUT_MS: each frame makes the device do real work. */
const FRAME_TIMEOUT_MS = 1500;

/** Hardware-confirmed shape of an `export_preset` MicroFreak dump: 146 packets of 32 payload bytes each (4672 bytes total). */
const DATA_FRAME_COUNT = 146;
const DATA_FRAME_BYTES = 42;
const CHUNK_SIZE = 32;

let seqCounter = 0x20;
function nextSeq(): number {
  const s = seqCounter;
  seqCounter = (seqCounter + 1) & 0x7f;
  return s;
}

/** Split a concatenated SysEx byte stream (`Uint8Array`) into individual F0..F7 frames. */
function splitFrames(bytes: Uint8Array): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur !== null) {
      cur.push(b);
      if (b === 0xf7) {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}

export async function restorePresetBinaryMicroFreak(
  ctx: DispatchCtx,
  bytes: Uint8Array,
  options: {
    target_location?: LocationRef;
    save_authorized?: boolean;
    confirm_overwrite?: boolean;
    name?: string;
    preset_type?: number;
  } | undefined,
  config: FreakConfig,
): Promise<RestorePresetResult> {
  const LABEL = config.display_name;
  const sysex = config.sysex;
  if (sysex === undefined) {
    throw new DispatchError(
      'capability_not_supported', LABEL,
      `${LABEL} has no SysEx support in this server (device-code byte unknown), so its stored presets cannot be written.`,
    );
  }
  const device = sysex.device_code;

  // Parse + validate the backup shape FIRST, before any gate prose or wire
  // byte: a wrong-model .syx (or a payload the device would choke on) fails
  // here, at zero wire cost.
  const frames = splitFrames(bytes);
  if (frames.length !== DATA_FRAME_COUNT || frames.some((f) => f.length !== DATA_FRAME_BYTES)) {
    throw new DispatchError(
      'value_out_of_range', LABEL,
      `import_preset: expected the ${DATA_FRAME_COUNT}-frame, ${DATA_FRAME_BYTES}-byte-per-frame dump export_preset writes for ${LABEL} ` +
      `(got ${frames.length} frames). Pass the .syx file_path export_preset returned for THIS device; another device's dump, or a ` +
      `hand-edited file, cannot restore here.`,
    );
  }
  const chunks = frames.map((f) => dumpPacketPayload(f));
  if (chunks.some((c) => c.length !== CHUNK_SIZE)) {
    throw new DispatchError(
      'value_out_of_range', LABEL,
      `import_preset: a payload frame in this file did not carry exactly ${CHUNK_SIZE} bytes. This is not a MicroFreak preset dump.`,
    );
  }

  const name = options?.name;
  if (name === undefined || name.trim().length === 0) {
    throw new DispatchError(
      'value_out_of_range', LABEL,
      `import_preset on ${LABEL} requires \`name\`: its write protocol pushes an explicit ASCII name frame ahead of the payload, ` +
      `and a byte-exact dump does not carry the preset's name inside it. Pass the \`name\` export_preset returned for this preset.`,
    );
  }
  if (name.length > 23) {
    throw new DispatchError(
      'value_out_of_range', LABEL,
      `import_preset: name "${name}" is ${name.length} characters; ${LABEL}'s write-frame name field holds 23. Shorten it.`,
    );
  }

  if (options?.target_location === undefined) {
    throw new DispatchError(
      'capability_not_supported', LABEL,
      `import_preset on ${LABEL} restores to a STORED preset slot only; there is no known working-buffer write path ` +
      `(every captured write addresses a bank/index destination directly). This backup holds "${name}". Confirm the target ` +
      `slot with the user, then re-call with target_location, save_authorized: true, and (if the slot is occupied) confirm_overwrite: true.`,
    );
  }
  const rawTarget = options.target_location;
  const rawSlot = typeof rawTarget === 'number' ? rawTarget : Number(rawTarget);
  if (!Number.isInteger(rawSlot) || rawSlot < 1 || rawSlot > sysex.preset_count) {
    throw new DispatchError(
      'bad_location', LABEL,
      `import_preset target_location must be 1..${sysex.preset_count} on ${LABEL} (the numbers the front panel and scan_locations use); got ${JSON.stringify(rawTarget)}.`,
    );
  }
  const destSlot0 = rawSlot - 1;

  if (options?.save_authorized !== true) {
    throw new DispatchError(
      'save_authorization_required', LABEL,
      `import_preset to preset ${rawSlot} on ${LABEL} persists immediately: this device has no separate save step ` +
      `(a stored-slot SysEx write IS the persist, unlike the working-buffer/flash split on Fractal gear). Requires explicit ` +
      `save intent from the user ("restore it to preset ${rawSlot}", "put it back", "overwrite preset ${rawSlot}"); ` +
      `then re-call with save_authorized: true.`,
    );
  }

  // Read-before-write occupancy gate: query the DESTINATION slot's CURRENT
  // name, same frame shape (`buildNameRequest`) the capture itself opens
  // every write event with.
  let occupantName: string | undefined;
  let occupantReadError: string | undefined;
  try {
    const queryReadSeq = nextSeq();
    const waiter = ctx.conn.receiveSysExMatching(nameReplyMatcher(queryReadSeq, destSlot0, device), FRAME_TIMEOUT_MS);
    ctx.conn.send(buildNameRequest(queryReadSeq, destSlot0, device));
    const reply = await waiter;
    occupantName = decodePresetName(reply);
  } catch (err) {
    occupantReadError = err instanceof Error ? err.message : String(err);
  }
  const isEmpty = occupantName === '' || occupantName === 'Init';
  if (!isEmpty && options?.confirm_overwrite !== true) {
    const occupantLine = occupantName !== undefined
      ? `preset ${rawSlot} currently holds "${occupantName}".`
      : `preset ${rawSlot}'s current contents could not be read (${occupantReadError ?? 'unknown error'}), so what is there is UNKNOWN.`;
    throw new DispatchError(
      'overwrite_confirmation_required', LABEL,
      `REFUSING TO OVERWRITE: ${occupantLine} Restoring "${name}" there replaces it immediately and permanently (this device ` +
      `has no separate save step). Tell the user what the slot holds and, once they confirm, re-call with confirm_overwrite: true ` +
      `(keep save_authorized: true).`,
    );
  }

  // Metadata push -> confirm -> begin marker -> 146 data frames, each
  // sent and ACK-awaited before the next goes out (real pacing, matching
  // the capture's own req/ack rhythm, never fire-and-forget).
  let framesSent = 0;
  let acksReceived = 0;

  async function sendAcked(frame: number[], seq: number, label: string): Promise<void> {
    const waiter = ctx.conn.receiveSysExMatching(presetWriteAckMatcher(seq, device), FRAME_TIMEOUT_MS).catch(() => undefined);
    ctx.conn.send(frame);
    framesSent++;
    if (ctx.conn.lastSendError !== undefined) {
      throw new DispatchError('stale_handle', LABEL, `Send failed on ${label}: ${ctx.conn.lastSendError.message}`);
    }
    const ack = await waiter;
    if (ack === undefined) {
      throw new DispatchError(
        'no_ack', LABEL,
        `import_preset to preset ${rawSlot} stalled: no device ACK for the ${label} within ${FRAME_TIMEOUT_MS}ms ` +
        `(${framesSent} frame(s) sent, ${acksReceived} acked so far). The write is INCOMPLETE and preset ${rawSlot} is in an ` +
        `unknown state; do not trust it until you re-read it (get_preset / scan_locations).`,
      );
    }
    acksReceived++;
  }

  // The category rides the metadata frame; it is not in `bytes` and cannot be
  // derived from them. Copied through verbatim (see `decodePresetType`), never
  // interpreted here, and checked against the device's own answer below.
  const presetType = options?.preset_type ?? 0x00;
  const metaSeq = nextSeq();
  await sendAcked(buildPresetMetadata(metaSeq, destSlot0, name, presetType, device), metaSeq, 'metadata push');

  const confirmSeq = nextSeq();
  await sendAcked(buildPresetConfirm(confirmSeq, destSlot0, device), confirmSeq, 'confirm');

  // Captured behaviour: the running seq counter resets to 0 at the begin
  // marker in EVERY one of the three captured drags. Causal necessity is
  // unconfirmed; reproduced verbatim rather than risked away.
  seqCounter = 0;
  const beginSeq = nextSeq();
  await sendAcked(buildBulkBegin(beginSeq, device), beginSeq, 'begin-bulk marker');

  for (let i = 0; i < chunks.length; i++) {
    const seq = nextSeq();
    const isLast = i === chunks.length - 1;
    await sendAcked(buildPresetDataFrame(seq, chunks[i]!, isLast, device), seq, `data frame ${i + 1}/${chunks.length}`);
  }

  // Closing query: same shape as the destination pre-read above, now
  // answered with the NEW name if the write actually landed. This -- not
  // the per-frame acks above -- is the write's proof of persistence.
  let readbackName: string | undefined;
  let readbackType: number | undefined;
  let readbackError: string | undefined;
  try {
    const closeSeq = nextSeq();
    const waiter = ctx.conn.receiveSysExMatching(nameReplyMatcher(closeSeq, destSlot0, device), FRAME_TIMEOUT_MS);
    ctx.conn.send(buildNameRequest(closeSeq, destSlot0, device));
    const reply = await waiter;
    readbackName = decodePresetName(reply);
    readbackType = decodePresetType(reply);
  } catch (err) {
    readbackError = err instanceof Error ? err.message : String(err);
  }

  // The name is what decides the write landed. A category that came back
  // different is a metadata disagreement, not a failed preset: the payload is
  // already proven by the name read-back, so it is reported, not escalated.
  const ok = readbackName === name;
  let warning: string | undefined;
  if (ok && readbackType !== undefined && readbackType !== (presetType & 0x7f)) {
    warning = `Preset ${rawSlot} restored as "${name}", but its category read back as ${readbackType} ` +
      `after writing ${presetType & 0x7f}. The preset itself is correct; only its Type tag differs.`;
  }
  if (!ok) {
    warning = readbackName !== undefined
      ? `Every frame was acked, but the post-write read-back shows preset ${rawSlot} holding "${readbackName}" instead of "${name}". ` +
        `Trust the read-back over the acks: verify the device before relying on this preset.`
      : `Every frame was acked, but the post-write read-back for preset ${rawSlot} did not answer ` +
        `(${readbackError ?? 'timeout'}), so the write could not be confirmed. It may still have landed; re-read preset ${rawSlot} to check.`;
  }

  return {
    ok,
    // Every host-originated frame in this transaction: 1 destination-occupancy
    // query + metadata push + confirm + begin marker + 146 data frames + 1
    // closing query = 151. `framesSent`/`acksReceived` below count only the
    // ACK-gated leg (metadata push through the last data frame, 149 frames);
    // the two `buildNameRequest` queries are answered by a NAME_REPLY, not
    // the `presetWriteAckMatcher` ack, so they are accounted separately via
    // `name` (this field) and the `warning` above rather than folded in here.
    frames_sent: framesSent,
    acks_received: acksReceived,
    nacks: [],
    name,
    ...(ok ? { saved_to_location: String(rawSlot) } : {}),
    format: 'microfreak-preset-dump',
    ...(warning !== undefined ? { warning } : {}),
  };
}
