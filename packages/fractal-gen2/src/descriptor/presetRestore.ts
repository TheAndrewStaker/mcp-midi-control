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
  buildStorePreset,
  isStorePresetResponse,
  parseStorePresetResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

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
  options?: { target_location?: LocationRef; save_authorized?: boolean; modelId?: number; deviceLabel?: string },
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

  // Optional persist to a stored location (dispatcher gates save_authorized).
  let saved_to_location: string | number | undefined;
  let storeOk = true;
  if (options?.save_authorized && options?.target_location !== undefined) {
    const wire = parseAxeFxIILocation(options.target_location, deviceLabel);
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

  return {
    ok: nacks.length === 0 && storeOk,
    frames_sent: messages.length,
    acks_received: responses.length,
    nacks,
    name,
    saved_to_location,
    format: 'axe-fx-ii-patch-dump',
  };
}
