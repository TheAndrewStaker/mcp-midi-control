/**
 * AM4 byte-exact preset restore (push) — backs the unified `apply_preset`
 * restore mode via `DeviceWriter.restorePresetBinary`.
 *
 * Pushes a 12,352-byte preset dump (produced by `export_preset`) back to the
 * device's WORKING BUFFER as a verbatim 6-message replay (the dump header
 * carries the active-buffer sentinel 0x7F/0x00, so it targets the working
 * buffer). `parsePresetDump` validates every envelope + checksum before any
 * byte hits the wire.
 *
 * Restore-to-stored-location is NOT supported yet: re-targeting the dump to a
 * stored A01..Z04 needs the stored-preset header encoding that is still
 * undecoded (HW-045). A working-buffer restore + a manual save is the path
 * until that capture lands.
 */
import type {
  DispatchCtx,
  LocationRef,
  RestorePresetResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { am4ComparableBody } from 'fractal-midi/am4';

import { parsePresetDump, PRESET_DUMP_LEN } from '../presetDump.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { AM4_DIRTY_LABEL } from '../tools/safeEdit.js';
import { decodeDumpBody, readActiveBufferDecoded } from '../shared/bufferState.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRAME_COUNT = 6; // header + 4 chunks + footer
const INTER_FRAME_MS = 15;
const SETTLE_MS = 400;
const DEVICE_LABEL = 'Fractal AM4';

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

export async function restorePresetBinaryAm4(
  ctx: DispatchCtx,
  bytes: Uint8Array,
  options?: { target_location?: LocationRef; save_authorized?: boolean },
): Promise<RestorePresetResult> {
  if (bytes.length !== PRESET_DUMP_LEN) {
    throw new DispatchError(
      'value_out_of_range',
      DEVICE_LABEL,
      `apply_preset restore: AM4 preset binary must be ${PRESET_DUMP_LEN} bytes; got ${bytes.length}. ` +
        `Pass the .syx that export_preset wrote for THIS device (an Axe-Fx II or other-model dump will not fit).`,
    );
  }
  if (options?.save_authorized && options?.target_location !== undefined) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `apply_preset restore to a STORED location is not supported on AM4 yet: the stored-preset header encoding is undecoded. ` +
        `Restore to the working buffer (omit save_authorized / target_location), then save on the device, or via the editor.`,
    );
  }
  // Validates every envelope + per-frame checksum; throws on corruption.
  parsePresetDump(bytes);

  const messages = splitSysEx(bytes);
  if (messages.length !== FRAME_COUNT) {
    throw new DispatchError(
      'value_out_of_range',
      DEVICE_LABEL,
      `apply_preset restore: AM4 preset binary parsed to ${messages.length} SysEx messages; expected ${FRAME_COUNT}.`,
    );
  }

  // Verbatim replay of the 6-message stream to the working buffer.
  const responses: number[][] = [];
  const unsub = ctx.conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    ctx.conn.send(m);
    await new Promise((r) => setTimeout(r, INTER_FRAME_MS));
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  unsub();

  // The replay pushes 6 frames into the working buffer, so on a real
  // restore the buffer no longer matches flash → dirty. But the replay
  // is fire-and-forget (no per-frame ack-await); only mark dirty if the
  // device echoed at least one frame per sent frame. A silent/dead handle
  // leaves the flag clean (fail-safe: no false "edited" refusal over a
  // restore that never landed).
  const allFramesEchoed = responses.length >= messages.length;

  // Evidence (contract review L2): the replay itself is fire-and-forget, so
  // read the working buffer back and compare its decoded body with the
  // file's. `ok` is true only on a byte-identical body.
  const verdict = await verifyRestoredBody(ctx, bytes);
  if (allFramesEchoed || verdict.kind === 'match' || verdict.kind === 'mismatch') {
    // The buffer was (at least partly) overwritten: it no longer matches flash.
    markDirty(AM4_DIRTY_LABEL);
  }

  return {
    ok: verdict.kind === 'match',
    frames_sent: messages.length,
    acks_received: responses.length,
    nacks: [],
    format: 'am4-preset-dump',
    ...(verdict.kind === 'match'
      ? { info: 'Restored to the working buffer: a read-back of the working buffer matches the preset content of the file (the loaded-from location word and a per-dump volatile word are not compared). Not saved; use save_preset to keep it.' }
      : { warning: verdict.warning }),
  };
}

type RestoreVerdict = { kind: 'match' } | { kind: 'mismatch' | 'unconfirmed'; warning: string };

export async function verifyRestoredBody(ctx: DispatchCtx, bytes: Uint8Array): Promise<RestoreVerdict> {
  const expected = decodeDumpBody(bytes);
  if (expected === undefined) {
    return {
      kind: 'unconfirmed',
      warning: 'The file was sent, but its preset body does not decode, so the restore could not be checked against a read-back. Check the AM4 display.',
    };
  }
  const actual = await readActiveBufferDecoded(ctx.conn);
  if (actual === undefined) {
    return {
      kind: 'unconfirmed',
      warning: 'The file was sent, but the working-buffer read-back did not answer, so the restore is unconfirmed. Check the AM4 display, or call get_preset to compare.',
    };
  }
  // Compare the CONTENT, not the raw bytes: the PATCH record carries the
  // loaded-from location word and a word that churns on every dump of an
  // untouched preset (hardware 2026-11-25: body 0x177C took 105, 53, 58, 11
  // across four exports with no edits), so a raw compare reported a false
  // "differs (2 bytes of 6222)" on a same-firmware round-trip.
  // am4ComparableBody zeroes exactly those two words; it is undefined when
  // the body does not walk, and then the raw bytes are compared.
  const rawA = expected.decompressedBody.subarray(0, expected.decompSize);
  const rawB = actual.decompressedBody.subarray(0, actual.decompSize);
  const a = am4ComparableBody(rawA, expected.decompSize) ?? rawA;
  const b = am4ComparableBody(rawB, actual.decompSize) ?? rawB;
  const offsets = differingOffsets(a, b);
  if (offsets.length === 0) return { kind: 'match' };
  const shown = offsets.slice(0, 8).map((o) => `0x${o.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
  const more = offsets.length > 8 ? `, +${offsets.length - 8} more` : '';
  return {
    kind: 'mismatch',
    warning: `The file was sent, but the working buffer read back differs from it (${offsets.length} byte(s) of ${a.length}, at body offset ${shown}${more}). ` +
      'That can be the firmware converting a file saved on other firmware, or a push that did not land; check the preset on the AM4 display, and use save_preset to keep it if it is right.',
  };
}

/** Body offsets where two decoded bodies differ (a length difference counts each missing byte). */
export function differingOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}
