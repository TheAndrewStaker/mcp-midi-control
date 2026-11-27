/**
 * Axe-Fx II byte-exact preset restore (push) — backs the unified
 * `apply_preset` restore mode via `DeviceWriter.restorePresetBinary`.
 *
 * Pushes a 12,951-byte preset dump (produced by `export_preset`) back to the
 * device. Default: working-buffer only (reverts on preset switch). With
 * `save_authorized` + `target_location`: also STORE_PRESET to that slot.
 *
 * Wire path is the same one hardware-verified for the (now-removed)
 * device-namespaced `axefx2_restore_preset`: 66 messages pushed with light
 * pacing, 0 NACKs on a clean dump. `parsePresetDump` validates every envelope
 * + checksum before any byte hits the wire, so corrupted input is rejected
 * client-side.
 */
import type {
  DispatchCtx,
  LocationRef,
  RestorePresetResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  buildEditBufferDumpRequest,
  buildStorePreset,
  isStorePresetResponse,
  parseStorePresetResponse,
} from 'fractal-midi/gen2/axe-fx-ii';
import { collectPatchDump } from './patchDumpIo.js';

import { parsePresetDump, extractPresetName, PRESET_DUMP_LEN } from '../presetDump.js';
import { parseAxeFxIILocation } from './schema.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRAME_COUNT = 66;
const INTER_FRAME_MS = 8;
const SETTLE_MS = 600;
const STORE_TIMEOUT_MS = 800;
const DEVICE_LABEL = 'Fractal Axe-Fx II XL+';

/** Split a flat dump into its component F0..F7 SysEx messages. */
function splitSysEx(bytes: Uint8Array): number[][] {
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== SYSEX_START) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== SYSEX_END) j++;
    if (j >= bytes.length) break;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  return messages;
}

export async function restorePresetBinaryAxeFxII(
  ctx: DispatchCtx,
  bytes: Uint8Array,
  options?: {
    target_location?: LocationRef;
    save_authorized?: boolean;
    modelId?: number;
    deviceLabel?: string;
    /** The model's physical preset count; bounds target_location. */
    presetCount?: number;
    /**
     * Skip the post-push edit-buffer read-back. Only for a caller that runs
     * its OWN verify dump right after (the atomic image apply), so the buffer
     * is not dumped twice. `ok` then rests on NACKs + the STORE ack alone.
     */
    skipReadBack?: boolean;
  },
): Promise<RestorePresetResult> {
  const deviceLabel = options?.deviceLabel ?? DEVICE_LABEL;
  const modelId = options?.modelId; // undefined -> buildStorePreset falls back to its own XL+ default
  if (bytes.length !== PRESET_DUMP_LEN) {
    throw new DispatchError(
      'value_out_of_range',
      deviceLabel,
      `apply_preset restore: Axe-Fx II preset binary must be ${PRESET_DUMP_LEN} bytes; got ${bytes.length}. ` +
        `Pass the .syx that export_preset wrote for THIS device (an AM4 or other-model dump will not fit).`,
    );
  }
  // Validates every envelope + per-frame checksum; throws on corruption.
  const parsed = parsePresetDump(bytes);
  const name = extractPresetName(parsed);

  const messages = splitSysEx(bytes);
  if (messages.length !== FRAME_COUNT) {
    throw new DispatchError(
      'value_out_of_range',
      deviceLabel,
      `apply_preset restore: preset binary parsed to ${messages.length} SysEx messages; expected ${FRAME_COUNT}.`,
    );
  }

  // Push the 66 frames to the working buffer, collecting any response frames.
  const responses: number[][] = [];
  const unsub = ctx.conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    ctx.conn.send(m);
    await new Promise((r) => setTimeout(r, INTER_FRAME_MS));
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  unsub();

  // NACK heuristic (matches the verified device-namespaced path): a response
  // on fn 0x64 with a non-zero result byte at offset 7.
  const nacks: { frame_index: number; detail?: string }[] = [];
  for (let k = 0; k < responses.length; k++) {
    const r = responses[k];
    if (r.length > 7 && r[7] !== 0x00 && r[5] === 0x64) {
      nacks.push({ frame_index: k, detail: `result 0x${r[7].toString(16)}` });
    }
  }

  // Evidence (contract review L2): the push is fire-and-forget, so dump the
  // edit buffer back (the sentinel request, no side effect) and compare its
  // 64 body frames with the file's. HW-132 showed a push restores the buffer
  // byte for byte, so a difference means the restore did not land as sent.
  const verdict: RestoreVerdict = options?.skipReadBack === true
    ? { kind: 'match' }
    : await verifyRestoredFrames(ctx, messages, modelId);

  // Optional persist to a stored location (dispatcher gates save_authorized).
  // Never STORE a buffer the device rejected frames of, or one that reads
  // back different from the file: that would persist a corrupt preset.
  let saved_to_location: string | number | undefined;
  let storeOk = true;
  const wantsStore = options?.save_authorized === true && options?.target_location !== undefined;
  const storeBlocked = wantsStore && (nacks.length > 0 || verdict.kind === 'mismatch');
  if (storeBlocked) storeOk = false;
  if (wantsStore && !storeBlocked && options?.target_location !== undefined) {
    const wire = parseAxeFxIILocation(options.target_location, deviceLabel, options.presetCount);
    const ackP = ctx.conn.receiveSysExMatching(isStorePresetResponse, STORE_TIMEOUT_MS);
    ctx.conn.send(modelId !== undefined ? buildStorePreset(wire, { modelId }) : buildStorePreset(wire));
    try {
      const parsedAck = parseStorePresetResponse(await ackP);
      storeOk = parsedAck.ok;
      if (parsedAck.ok) saved_to_location = wire + 1; // wire 0-based → display
    } catch {
      storeOk = false;
    }
  }

  const warnings: string[] = [];
  if (verdict.kind !== 'match') warnings.push(verdict.warning);
  if (storeBlocked) {
    warnings.push(
      nacks.length > 0
        ? 'The STORE was NOT sent, so nothing was saved: the device rejected frames of the push.'
        : 'The STORE was NOT sent, so nothing was saved: the read-back differs from the file. If the preset sounds right on the device, call save_preset to keep it.',
    );
  } else if (wantsStore && !storeOk) {
    warnings.push('The STORE did not ack; whether it saved is unknown. Reload the location on the device to check.');
  } else if (wantsStore && saved_to_location !== undefined && verdict.kind === 'unconfirmed') {
    warnings.push(`It WAS saved to slot ${saved_to_location} (the STORE acked), though the read-back could not confirm the contents.`);
  }

  return {
    ok: nacks.length === 0 && verdict.kind === 'match' && storeOk,
    frames_sent: messages.length,
    acks_received: responses.length,
    nacks,
    name,
    saved_to_location,
    format: 'axe-fx-ii-patch-dump',
    ...(warnings.length > 0
      ? { warning: warnings.join(' ') }
      : options?.skipReadBack === true
        ? {}
        : { info: 'A read-back of the edit buffer matches the file byte for byte.' }),
  };
}

type RestoreVerdict = { kind: 'match' } | { kind: 'mismatch' | 'unconfirmed'; warning: string };

/** Compare the 64 body frames (0x78) of a fresh edit-buffer dump with the pushed ones. */
export async function verifyRestoredFrames(
  ctx: DispatchCtx,
  pushed: readonly number[][],
  modelId?: number,
): Promise<RestoreVerdict> {
  let frames: number[][];
  try {
    frames = await (async () => {
      const p = collectPatchDump(ctx, modelId !== undefined ? { modelId } : undefined);
      ctx.conn.send(buildEditBufferDumpRequest(modelId !== undefined ? { modelId } : {}));
      return p;
    })();
  } catch (err) {
    return {
      kind: 'unconfirmed',
      warning: `The file was sent, but the edit-buffer read-back failed (${err instanceof Error ? err.message : String(err)}), so the restore is unconfirmed. Check the front panel, or call get_preset to compare.`,
    };
  }
  const body = (list: readonly number[][]) => list.filter((f) => f[5] === 0x78);
  const want = body(pushed);
  const got = body(frames);
  if (got.length !== want.length) {
    return {
      kind: 'unconfirmed',
      warning: `The file was sent, but the edit-buffer read-back returned ${got.length} body frames, not ${want.length}, so the restore is unconfirmed.`,
    };
  }
  let differing = 0;
  for (let i = 0; i < want.length; i++) {
    const a = want[i];
    const b = got[i];
    // Compare payloads (the model byte and checksum are envelope, not content).
    const same = a.length === b.length && a.every((v, k) => k === 4 || k === a.length - 2 || v === b[k]);
    if (!same) differing++;
  }
  if (differing === 0) return { kind: 'match' };
  return {
    kind: 'mismatch',
    warning: `The file was sent, but the edit buffer reads back different from it (${differing} of ${want.length} body frames differ). ` +
      'That can be the firmware converting a file saved on other firmware, or a push that did not land; check the preset on the front panel.',
  };
}
